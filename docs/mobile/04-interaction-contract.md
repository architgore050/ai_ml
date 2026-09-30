# Phase 3 — The interaction & telemetry contract

Date: 2026-09-30. This is the answer to `03-handoff.md` §7a, whose two research
agents both failed on network certificate errors. Every claim below was read out
of the source in this repo at `a10fe14` + the working tree on top of it; nothing
is carried over from a plan. Where a plan, a prior report or a belief recorded
in `03-handoff.md` is wrong, §1 and §9 say so and give the correct version.

**Status of the client code this describes: it does not exist yet.**
`mobile/src/api/endpoints/` contains `auth.ts` and `feed.ts` only.
`mobile/src/store/player.ts` (576 lines) owns the player and the token cache and
has no watch-time accumulator, no `toggle-like`, no `register-skip`, no
`log-telemetry`. This document is the specification a future agent implements
from, not a description of shipped behaviour. `03-handoff.md` §4 (the player
store defects) is unrelated to this file, still stands, and is not restated or
revised here.

**One correction to the research brief that produced this file, up front:** the
two native-source paths it cites (`ios/AudioPlayer.swift`,
`BaseAudioPlayer.kt`) are not in the repository. `mobile/` is an Expo managed
app — there is no `mobile/ios/` and no `mobile/android/`. The files live in the
vendored dependency at `mobile/node_modules/expo-audio/ios/AudioPlayer.swift` and
`mobile/node_modules/expo-audio/android/src/main/java/expo/modules/audio/BaseAudioPlayer.kt`.
The *premises* about their behaviour are correct and are re-cited against the
real paths in §4 C7.

---

## 1. The three corrections

These are the reason this file exists. Each one overturns something a Phase-3
agent would otherwise code from.

### 1.1 The skip rule was being read backwards

`docs/mobile-rebuild-plan.md:759-762` specifies:

> **`hooks/useWatchTelemetry.ts`** — 5s heartbeat off `player.currentTime`.
> Sends `log-telemetry` always; sends `register-skip` **only** when
> `position < duration × 0.9` **and** the transition was user-initiated.

That is "skip on **early abandonment**". It is correct. A user who bails at 20 %
of a clip is the signal; a user who reaches the end is not.

A rule of "fire a skip at `progress >= 0.99`" is **the old app's defect** —
`docs/mobile-rebuild-plan.md:474`, defect 2: *"Listening to the end increments
the skip counter. Natural completion fires `registerSkip` with
`listen_duration_ms: 0`."* Auto-advance at ≥ 0.99 must **advance**, and must
**not** report a skip.

The confusion is structural rather than a single bad sentence, and the source
shows why it is easy to fall into:

| Threshold | What it belongs to | Where |
|---|---|---|
| `progress >= 0.99` → advance after 1000 ms | **auto-advance pacing** | `mobile-rebuild-plan.md:664`; `03-handoff.md` §7b task **3k** |
| `position < duration × 0.9` **and** user-initiated → skip | **the skip guard** | `mobile-rebuild-plan.md:606, :762`; `03-handoff.md` §7b task **3b** |

Two different rules, both present in the same 13-row task table, one of them
about advancing and one about reporting. Task 3b specifies the guard's
*signature* — `shouldRegisterSkip({positionMs, durationMs, userInitiated})` — and
**no threshold at all**. A future agent reading 3b in isolation has nothing to
implement and nothing to test against. §4 pins the missing constants so that is
no longer the case.

The two rules are also not complements: `0.99` advance and `0.9` skip leave a
band between `0.9` and `0.99` where a user-initiated swipe is *neither* an
advance trigger nor a skip. That is the intended reading — it is abandonment,
and abandonment needs a reason.

### 1.2 `log-telemetry` does not move `avg_completion_rate` on the healthy path

The whole of `record_telemetry`'s body after computing the rate
(`backend/app/services/interactions.py:370-422`):

```
370:  completion_rate = _completion_rate(watch_time_ms, clip)
371:  if completion_rate is None:
377:      completion_rate = 0.0
378:  event = { ... }
386:  try:
387:      if _use_stream():
388:          if _xadd_telemetry(event):
389:              return event                     <-- returns here
390:      _rpush_telemetry(event)
391:  except Exception:
...
405:      from . import counter_store
406:      try:
407:          counter_store.add_completion(       <-- tier-3 only
408:              str(clip.id), str(user.id), completion_rate,
409:          )
```

`counter_store.add_completion` is reachable only inside the `except` at `:391`,
which runs only after **both** the stream `XADD` (`:388`) and the list `RPUSH`
(`:390`) have already raised. So the 30 %-of-ranking term
(`backend/app/services/feed_pool.py:152, :225`) is moved **only** by
`register-skip`.

**Any product reasoning premised on "telemetry trains the recommender" is false
today.** `03-handoff.md` §7a asked the opposite question — *"Confirm
`UserInteraction.completion_rate` is write-only (the ranker reads
`AudioClip.avg_completion_rate`), so telemetry cannot poison the recommender and
`register-skip` is the only poison path."* — and drew the wrong conclusion. The
column is **not** write-only, and telemetry **does** poison the recommender, just
not the one the question was about.

**The consequence, and the real sink of `watch_time_ms`.** The stream consumer
writes the rate straight into the row: `tasks.py:995-997`
(`interaction_type=action_type, watch_time_ms=watch_ms, completion_rate=completion`).
That column is read by `ai_ml/pipelines/recommendation.py:124`:

```python
124:  comp_weight = interaction.completion_rate if interaction.completion_rate > 0 else 0.1
```

`comp_weight` multiplies the clip's 384-d semantic and 128-d acoustic vectors into
the **user's own taste profile** (`:133`
`final_weight = time_weight * comp_weight * intent_weight`, applied at `:135-140`),
which is then 45 % of the composite (`feed_pool.py:151, :224`). There is a **floor
of 0.1 and no cap**. A `completion_rate` of `1.0` over-weights that clip **10×**
relative to the floor — on the next recompute (the consumer invalidates
`user_vectors:{id}` at `tasks.py:1036-1042`), and permanently after the daily
`evolve_long_term_user_baselines` (`tasks.py:596`, 86400 s, `settings.py:573-575`),
which calls the *same* `calculate_time_decayed_vectors` at `tasks.py:610`.

**This inverts the intuition, and that is the point.** The column the old defect
corrupted (`avg_completion_rate`) is the better-defended one: divisor is server
state, there is a tolerance band, and samples are capped at 3 per `(user, clip)`
per day. The column the rewrite silently starts using — telemetry →
`UserInteraction.completion_rate` → the user's own vector — is the undefended
one: no cap, no per-request band, and a 10× weight multiplier.

### 1.3 `action_type` is a data-corruption primitive and only `'view'` is safe

`InteractionTelemetrySerializer.action_type` is a plain `ChoiceField` over
`view | like | share | skip` (`backend/app/serializers.py:815`). The consumer
writes the client's string straight into `UserInteraction.interaction_type`
(`tasks.py:995`). It is never cross-checked against the counters.

| `action_type` sent | What the client then sees | What the DB says |
|---|---|---|
| `'like'` | `is_liked: true` in `GET /feed/` **and** `GET /profile/me/` — `FeedClipSerializer.get_is_liked` (`serializers.py:668-676`) reads `user_has_liked`, else falls back to `UserInteraction.objects.filter(interaction_type='like', is_active=True)`, and the consumer sets `is_active=True` (`tasks.py:994`) | `AudioClip.likes` **never moves.** `bulk_create` bypasses `UserInteraction.save()`, so the `counter_store.increment` hook (`models.py:310-313`) never fires. |
| `'share'` | a row in the user's own share history | `AudioClip.shares` never moves; the share **inbox** (`ShareEvent`) is unaffected |
| `'skip'` | nothing visible | `recommendation.py:130-131` — `intent_weight = -0.5` when `interaction_type == 'skip' and completion_rate < 0.2`. A self-inflicted negative weight on the user's own vector. |
| `'view'` | neutral | neutral |

The `'like'` case is the one that matters: **the UI and the counter disagree
permanently and no status code says so.** A forged like makes a clip look liked
in the feed, in the user's own liked list, and in every share-inbox preview
(`views/social.py:50-67` annotates the same `user_has_liked`) while the author's
`AudioClip.likes` — and therefore `engagement_velocity`, 25 % of the composite
(`feed_pool.py:153`) — is untouched.

So: **the mobile client must send `'view'` and nothing else, and the design
should make that structurally impossible rather than a convention.** The
structural fix is a one-line change on the server — ignore
`serializer.validated_data['action_type']` and hardcode `'view'` at
`views/interactions.py:175`, the way `flush_counters_to_pg` already does at
`tasks.py:1848` — or drop the field from the serializer entirely. That is a
backend change and therefore outside this document's authority, but it should be
raised rather than left as a client-side convention. Until it lands, C1 below is
load-bearing.

---

## 2. The verified endpoint contracts

All three actions live on one viewset, `ClipInteractionViewSet`
(`backend/app/views/interactions.py:24`), registered at `/interactions`
(`backend/app/urls.py:76`).

**There is no `/api/v1/` prefix.** `backend/EchoFlow/urls.py:9` is
`path('', include('backend.app.urls'))`. The only prefixed route in the project
is the media-worker heartbeat at `urls.py:13`. Several docstrings in
`views/subscription.py` are wrong about this (`03-handoff.md` §7c already noted
it); it is repeated here because it is the single most common way a new client
gets a 404 on every request.

### 2.1 Shared surface

| Property | Value | Source |
|---|---|---|
| Auth | `IsAuthenticated`; 401 on absent/expired access token | `views/interactions.py:25` |
| **403 before 404** | a clip outside the caller's interaction scope 404s (see below) | `views/interactions.py:100-103, :105-119` |
| Minor gate | `403 {"detail": "Telemetry is not collected for accounts of users under 18."}` — **only** on `log-telemetry` | `views/interactions.py:158-166` |
| Unknown keys | **silently dropped** | DRF `rest_framework/serializers.py:506` — `fields = self._writable_fields`, then `for field in fields:` at `:508`. Anything not declared is never read. |
| Content type | JSON. DRF's `JSONParser`; an unparseable body is 400 `{"detail": "JSON parse error …"}` | |

**The scope filter is new and load-bearing.** `c12f16b` gave the viewset a
`get_queryset()` (`views/interactions.py:105-119`) restricted to

```
creator == me
OR (moderation_approved = true AND (a ShareEvent sent it to me OR licence-clean))
```

A clip that fails this is a **404**, not a 403 — deliberately, so the answer does
not confirm the clip exists. Any client that keeps a `FeedClip` beyond moderation
revocation, or that holds an NC/SA clip from a cached feed, will get 404s from
all three actions.

**A 2xx is not evidence the server read what you sent.** Because DRF iterates
only declared writable fields, a *misspelled required* field 400s (it is
`required=True`, and `run_validation` on a missing key raises) but a *misspelled
extra* field is invisible — dropped with no error, no log line, and no way to
tell from the response. Send `watch_tim_ms` and you get a 202 plus a
`UserInteraction` row with `watch_time_ms = 0`. This is the mechanism behind §6's
write-once trap, and it is worth a client-side test that asserts the row it
expects, not just the status it got.

### 2.2 `POST /interactions/{clip_uuid}/toggle-like/`

| | |
|---|---|
| Body | **None is read.** The action never touches `request.data` (`views/interactions.py:121-126`). An empty body is fine. |
| Success | `200 {"status": "liked"}` or `200 {"status": "unliked"}` — `:125-126` |
| Errors | `401`, `404` (out of scope), `429`. **No 403** — likes are open to minors by explicit design, `:155-157` |
| **Not in the response** | the new like count. `AudioClip.likes` moves via a Redis delta applied on the next 300 s beat, so there is no count to read here at any latency. Do not diff it locally; refetch the clip or keep the optimistic value. |
| Throttle | `anon: 100/hour` (per IP, inherited) · `user: 1000/hour` · `interaction: 60/min` — `views/interactions.py:15, :180-186` + `settings.py:886-940` |
| Cache key | `throttle_interaction_<user.pk>` — DRF `throttling.py:238-249` |

**It is a true toggle.** `services/interactions.py:144-152`:

```python
144:  interaction, created = UserInteraction.objects.get_or_create(
145:      user=user, clip=clip, interaction_type='like',
148:      defaults={'is_active': True},
149:  )
150:  if not created:
151:      interaction.is_active = not interaction.is_active
152:      interaction.save()
```

`created` is the only state; there is no idempotency key, no `desired_state`
field, and no request body to carry one. **A blind retry after a timeout silently
UNLIKES.** `03-handoff.md` §7b task 3f already flagged the shape of this
("re-POSTing the same state does not re-toggle" — true, which is exactly the
hazard).

Liking **your own clip is allowed** (the `creator == me` branch of the scope) and
costs one unit of `engagement_velocity` to your own clip, since
`_apply_engagement_velocity` recomputes from `AudioClip.likes` on the next beat
(`tasks.py:1684-1687`). A self-like is not filtered anywhere. Suppress the like
button on your own clips in the UI; that is presentation, not enforcement.

### 2.3 `POST /interactions/{clip_uuid}/register-skip/`

`201 {"status": "skip/view registered"}` — note the **literal space** in the
string (`views/interactions.py:140`).

Body, `SkipActionSerializer` (`serializers.py:763-766`):

| Field | Type | Required | Bounds | Read? |
|---|---|---|---|---|
| `listen_duration_ms` | int | yes | `min_value=0`, **no max** | **Yes** — the only field the view forwards (`:137`) |
| `reel_position_ms` | int | yes | `min_value=0` | Validated, then **never referenced.** `record_skip`'s signature takes it (`services/interactions.py:232`) and the body never uses it. |
| `reel_id` | UUID | yes | — | **Validated and discarded.** `views/interactions.py:134-139` forwards exactly two kwargs. |

**Send `reel_id = clip.id`.** There is no `reel` table and nothing validates the
value against anything — a client that generates its own reel UUID is permanently
400, and a client that omits it is permanently 400. `03-handoff.md` §7a asked
precisely this ("Is `SkipActionSerializer.reel_id` required-but-never-read?") —
yes, and being `required=True` makes it required *in practice* too.

**The 201 does not mean the sample was recorded.** `record_skip` returns
`services/interactions.py:313-318`:

```python
313:  return {
316:      'completion_rate': completion_rate if recorded else 0.0,
317:      'completion_sample_recorded': recorded,
318:  }
```

and `views/interactions.py:134-139` calls it as a statement, discarding the dict.
So a request whose claim exceeded the over-report tolerance (§3) returns **201
with the same body** as one that landed, and only `AudioClip.skips` moved. This
is intentional and correct server behaviour — the honest response to a forged
claim is to drop the sample, not to tell the attacker which submissions worked —
but it means the client cannot use the response for anything.

Errors: `400` (any of the three fields, including a non-UUID `reel_id`), `401`,
`404`, `429`. **No 403** — skips are open to minors by design.

### 2.4 `POST /interactions/{clip_uuid}/log-telemetry/`

**202**, not 200: `views/interactions.py:178` (`{"status": "telemetry logged"}`).

Body, `InteractionTelemetrySerializer` (`serializers.py:814-820`):

| Field | Type | Required | Bounds |
|---|---|---|---|
| `action_type` | ChoiceField `view\|like\|share\|skip` | yes | — (see §1.3) |
| `watch_time_ms` | int | yes | `min_value=0`, `max_value=36_000_000` (10 h) |

**403 for a minor is permanent, and it fires before the clip lookup.**

```python
158:  if request.user.is_minor:
163:      return Response(
164:          {"detail": "Telemetry is not collected for accounts of users under 18."},
165:          status=status.HTTP_403_FORBIDDEN,
166:      )
168:  clip = self.get_object()          <-- only now
```

Three consequences, all client-relevant:

1. A minor gets **403 for a clip that does not exist**. Do not treat 403 here as
   a clip-scoped error.
2. It is a property of the **account**, not the clip or the request. `is_minor` is
   written in exactly two places, both in `RegisterSerializer`
   (`serializers.py:984, :1002`), and no endpoint mutates it. So the answer will
   not change for the life of the account — **latch and stop** (C9).
3. The 403 still **consumes throttle budget**, because DRF checks throttles in
   `initial()` after `perform_authentication` and before the handler is
   dispatched. A latched client that keeps retrying therefore drains the
   `telemetry: 60/min` bucket. That bucket is per-user, so no bystander is
   affected — but the account's own likes and skips run on the separate
   `interaction` scope, so the visible effect is that a retry loop eventually
   produces 429s, which *look* like rate limiting and will send the next
   debugging pass down the wrong road.

**`reel_id` and `reel_position_ms` are not accepted here** — `log-telemetry` reads
`action_type` and `watch_time_ms` only (`:175-176`).

### 2.5 Units

Every `*_ms` field crossing this API is **milliseconds**. `expo-audio` is
**seconds** throughout: `status.currentTime`, `status.duration`, `seekTo(seconds)`.
The repo already has the conversion helpers and names them
(`mobile/src/store/player.ts:35-38`, `msToSeconds` / `secondsToMs`), and
`player.ts:22-31` documents the hazard in terms worth repeating to the Phase-3
implementer: a silent factor-of-1000 error corrupts the completion-rate telemetry
that drives the recommender, **with no visible symptom**.

There is **no server-side normalisation.** `services/interactions.py:218` is the
entire treatment of the numerator:

```python
218:  listened = max(0, int(listen_duration_ms or 0))
```

Floors at zero, coerces to int, and stops. A seconds-denominated value is
accepted, is 1000× too small, and scores ~0.0.

---

## 3. The server's completion arithmetic, and its tolerance band

The whole function, `backend/app/services/interactions.py:187-225`:

```python
187:  def _completion_rate(listen_duration_ms: int, clip: AudioClip) -> float | None:
...
215:      expected_duration = clip.duration_ms or 0
216:      if expected_duration <= 0:
217:          expected_duration = _ZERO_DURATION_FALLBACK_MS
218:      listened = max(0, int(listen_duration_ms or 0))
219:      tolerance = max(
220:          _OVERCLAIM_TOLERANCE_MS,
221:          int(expected_duration * _OVERCLAIM_TOLERANCE_RATIO),
222:      )
223:      if listened > expected_duration + tolerance:
224:          return None
225:      return min(listened / expected_duration, 1.0)
```

with the constants at `:176-177` and `:184`:

```python
176:  _OVERCLAIM_TOLERANCE_MS = 2_000
177:  _OVERCLAIM_TOLERANCE_RATIO = 0.10
184:  _ZERO_DURATION_FALLBACK_MS = 60_000
```

| Property | Value | Source |
|---|---|---|
| Divisor | `clip.duration_ms` — **server state**, not client-influenced | `:215` |
| Divisor when `duration_ms <= 0` | `60_000` (10 % of a typical short-form clip) | `:184, :216-217` |
| Tolerance | `max(2_000, int(duration × 0.10))` | `:219-222` |
| Beyond `duration + tolerance` | returns `None` — **no sample at all** | `:223-224` |
| In band | `min(listened / duration, 1.0)` | `:225` |

**The `min(…, 1.0)` at `:225` is actively harmful in-band.** A claim of
`duration + 1 ms` is scored **exactly 1.0** — the maximum possible input to the
30 % term — and 1 ms past the duration is 4 000× closer to the band edge than to
the tolerance floor. The band is `[0, duration + max(2000, 10 %)]`, and the
mapping onto it is `min(ratio, 1.0)`, so the entire region above `duration` is
indistinguishable from a perfect watch. **Only the client-side cap (C4) prevents
an in-band over-claim from being worth anything.**

**There is no lower bound.** `listen_duration_ms: 0` is accepted and recorded as
a real `0.0` sample: `recorded = completion_rate is not None` (`:295`), and `0`
is not `None`. The old defect's exact input is still legal. This is C3.

**The "three divergence sites" are gone.** `git log -S "_ZERO_DURATION_FALLBACK_MS"`
and `git log -S "max(clip.duration_ms"` both return exactly one commit —
`a10fe14`, *"fix(security): derive the rights flags from the licence, and resolve
shared clips"*. Before it, `record_telemetry` did its own
`min(watch_time_ms / max(clip.duration_ms, 1), 1.0)`, so a 1 ms claim against a
zero-duration clip scored a perfect 1.0 while the same claim on the skip path
scored 1/60 000. At HEAD there is **one** fallback, used by both paths
(`:291` in `record_skip`, `:370` in `record_telemetry`).

> **Stale belief, still in `03-handoff.md` §7a:** *"Note: `record_telemetry` uses
> `max(clip.duration_ms, 1)` while `record_skip` falls back to 60,000 — two
> different 'unknown duration' answers, one of them catastrophic."* That was
> accurate against pre-`a10fe14` code. It is **not** the state of the tree. The
> regression guard is
> `backend/app/tests/test_ranking_exploit_cap.py:481-490`
> (`TestZeroDurationClipDoesNotScorePerfect`), which asserts
> `_completion_rate(1, zero_duration_clip) == 1/60_000`, plus a companion test
> asserting the telemetry path agrees with the skip path.

**The asymmetry that remains.** Both paths bound the claim from above; they
differ in what they do with it:

| | over-claim (`> duration + tolerance`) | in-band claim |
|---|---|---|
| `record_skip` | `None` → `recorded = False` → **no `add_completion` call**; `AudioClip.skips` still increments (`:295-300`) | scored 0…1.0 |
| `record_telemetry` | `None` → **coerced to `0.0` and shipped** (`:371-377`) | scored 0…1.0 |

The coercion is forced: `UserInteraction.completion_rate` is
`FloatField(default=0.0)` and NOT NULL (`models.py:265`), the consumer
bulk-creates one row per event, and the column has no way to represent "no
sample". So on the telemetry path an over-claim becomes a **real 0.0 sample** —
bounded upward, but still able to drag the `comp_weight` term **down** to the
0.1 floor for that `(user, clip)`. The docstring at `:355-368` says this plainly
and is worth reading before anyone "simplifies" it.

---

## 4. The client rules

Ranked **CORRECTNESS** (corrupts shared state or a recommender), then
**COURTESY** (wastes someone else's budget), then **HYGIENE**. Every correctness
rule names the field it corrupts and the magnitude.

### 4.1 CORRECTNESS

---

**C1 — `action_type` must be `'view'`, always.**
Corrupts `UserInteraction.interaction_type`; the consumer writes the string
verbatim (`tasks.py:995`).
Magnitude: a forged `'like'` makes `is_liked` true in `GET /feed/` and
`GET /profile/me/` and in every share-inbox preview, while `AudioClip.likes`
never moves — **a permanent, silent UI/counter divergence**; a forged `'skip'`
applies `intent_weight = -0.5` (`recommendation.py:130-131`) to the user's own
taste vector. See §1.3. The 202 response is identical either way, so the client
cannot detect the mistake after the fact.
Implementation: hardcode the string. Do not thread an `action_type` parameter
through the telemetry function — the fewer call sites can express the wrong
value, the better.

---

**C2 — Send accumulated *watch time*, never media position.**
Corrupts `listen_duration_ms` / `watch_time_ms`, and through them
`completion_rate` on both paths.
The web client's own post-mortem, `frontend/src/stores/player.tsx:288-301`:

> This is the fix for `watch_time_ms` being the media *position*.
> `services/interactions.py:282-283` computes
> `completion_rate = min(watch_time_ms / clip.duration_ms, 1.0)` and that
> feeds `AudioClip.avg_completion_rate`, which is 30 % of the ranking
> composite. Sending `audio.currentTime * 1000` therefore let a user seek
> to 0:55 of a 60 s clip and record a 0.92 completion for one second of
> listening.

Magnitude: seek to 55 s of a 60 s clip → `r = 0.92` for one second of playback,
Δcomposite `0.30 × 0.92 = +0.276` on that clip from a single request. (That
citation names pre-`a10fe14` line numbers for the arithmetic; the current helper
is `:187-225` and the claim itself is unchanged.)
Implementation: accumulate `Δ wall-clock` across ticks, and **only** credit a
tick where the player was actually advancing. See C7 for what "advancing" means
on each platform. The web client's shape is the reference:
`TELEMETRY_INTERVAL_MS = 6000` (`player.tsx:134`), `watchedMs` + `lastTickAt`
(`player.tsx:301-303`), reset in the same block as the clip change
(`player.tsx:641-642`).

---

**C3 — Never send `listen_duration_ms: 0`.**
Corrupts `completion_rate` — `_completion_rate(0, clip)` returns `0.0`, not
`None` (`:218` floors, `:225` divides) — and on the skip path therefore drags
`avg_completion_rate` **down**.
Magnitude: natural completion is the single most common event in a feed. If the
client reports it as a 0 ms skip, every clip a user watches to the end is
recorded as a 0 % completion. On a clip with 200 honest samples/beat at
`m_h = 0.5`, three systematic zeros per day move the steady state by
`3/(H+3) × (0 − 0.5) = −0.0074` acr, `−0.0022` composite — small. The damage is
**cumulative and directional**: a one-way ratchet on the most frequent event,
and the exact defect the old app shipped (`mobile-rebuild-plan.md:474`).
Rule: if the claim would be 0, **send nothing at all.** Telemetry and skip are
both optional per clip. `03-handoff.md` §7b task 3d is adjacent — "403 ⇒ minor,
surface it, never retry" — and "nothing to say" is the same instinct.

---

**C4 — Cap the claim at `min(elementDurationMs, clip.duration_ms)` before sending.**
Guards the in-band `1.0` conversion (§3). Two reasons to prefer the *element*
duration when it is smaller: `clip.duration_ms` is probed by ffprobe and floored
to whole ms, so it can be a frame or two short of the real asset (which is the
legitimate over-run the tolerance at `:219-222` exists for); and on a resumed HLS
session the element duration is what the player will actually reach.
Implementation: `Math.min(watchedMs, secondsToMs(elementDuration))`. The store
already has `secondsToMs` (`player.ts:38`).
This does **not** make an in-band over-claim impossible — it bounds it by the clip
length, which is the point.

---

**C5 — Snapshot `{clipId, watchTimeMs, positionMs, durationMs}` at EVENT time.
Never read live player state at send time.**
This is the rule with the most dangerous concrete failure, so here it is in full.

> A user is 280 s into a 300 s clip A (`watchedMs = 280000`). A heartbeat is
> queued but not yet sent — a slow network, a backgrounded fetch, an `await` on a
> token refresh. The user swipes to clip B, which is 10 s long. The queued
> heartbeat now fires. If the send path reads `watchedMs` **and the current
> clip's** `durationMs` live, it computes the C4 cap as
> `min(280000, 10000) = 10000` and sends `watch_time_ms: 10000` against **B**.

Server-side, for clip B (`duration_ms = 10000`):

- tolerance = `max(2_000, int(10000 × 0.10)) = 2_000`
- `listened = 10000`; is `10000 > 10000 + 2000`? **No** — in band.
- `r = min(10000 / 10000, 1.0)` = **1.0**

So: **`r = 1.0` on a 10 s clip the user watched for 0 seconds.** Consequences:

| Field | Value | Effect |
|---|---|---|
| `UserInteraction.completion_rate` | `1.0` | `comp_weight = 1.0` instead of the 0.1 floor — **10×** on B's semantic + acoustic vectors in the user's taste profile (§1.2), baked in permanently by the daily `evolve_long_term_user_baselines` |
| `UserInteraction` row existence | `(user, B, 'view')` at `created_at = now` | B is excluded from this user's feed for **30 days** — `recommendation.py:198-202` |
| `AudioClip.avg_completion_rate` | unchanged | telemetry does not call `add_completion` (§1.2) |

And the *upside* case is just as bad in the other direction: the honest 280 s of
watch time on clip A is **lost**, because it was never sent against A.

Implementation: the payload is built at the moment the event occurs, not at the
moment the request is issued. A heartbeat that cannot be attributed to a
`(clipId, watchTimeMs)` pair captured at event time should be **dropped**, not
re-derived from whatever the player looks like now. This is the single rule whose
violation is invisible in testing and catastrophic in production, so it should be
a pure function with an exhaustive test — which is what `03-handoff.md` §7b task
3b asks for, just about the wrong quantity.

---

**C6 — Snapshotting at event time requires the accumulator reset to be in the
same synchronous store write as the clip change.**
C5 is unimplementable if the clip id and the accumulator can be observed
inconsistently.

`frontend/src/stores/player.tsx:636-645` does it correctly, and the store's own
comment explains why — the block is a run of synchronous assignments on a plain
mutable session object, with no `await` between them:

```js
635:  const s = session.current;
636:  s.clip = clip;
...
641:  s.watchedMs = 0;
642:  s.lastTickAt = 0;
643:  s.lastTelemetryAt = Date.now();
```

**But this is achieved by accident, not by design.** It works because that
function happens to mutate a plain mutable session object synchronously. Nothing
in the type system or the store API prevents the next edit from inserting an
`await`, moving the reset into a `useEffect`, or routing the clip id through
component state. A zustand store with async state (a `loadClip` that `await`s, a
token refresh that `await`s) gives **no such guarantee**: a `getState()` read
during an in-flight `loadClip` returns a half-updated object.

Implementation requirements for `mobile/src/store/player.ts`:

- one `setClip(clip)` action that clears `watchedMs`, `lastTickAt` and
  `lastTelemetryAt` **in the same `set()`** as the new `clipId`;
- the telemetry emitter reads a value it was **handed**, not one it looks up;
- a unit test that interleaves `loadClip(A)` → tick → `setClip(B)` → flush and
  asserts the flushed payload names **A** with A's watch time. Without the
  interleave, the test passes against the broken implementation.

---

**C7 — Never send telemetry while paused, backgrounded or buffering, and apply a
per-tick credit ceiling.**
Corrupts `watch_time_ms` with wall-clock time during which nothing was heard.
The 500 ms status cadence is **not** a playback-progress signal, and the two
platforms fail differently:

| Platform | Behaviour | Source |
|---|---|---|
| iOS | `registerTimeObserver()` registers `addPeriodicTimeObserver` once, and the handler unconditionally calls `updateStatus(with: ["currentTime": time.seconds])`. The observer keeps firing on its interval **forever** once play is pressed — including while paused, stalled and backgrounded — and during a stall `time.seconds` is *frozen*. A 2 Hz status event with a constant `currentTime` is what a stall looks like. | `mobile/node_modules/expo-audio/ios/AudioPlayer.swift:474-491` (removal at `:326-329`) |
| Android | `startUpdating()` launches a flow on a `delay(updateInterval)` loop, but the emit is gated: `if (playing) { sendStatusUpdate() }`. While not playing it **stops writing entirely**. | `mobile/node_modules/expo-audio/android/src/main/java/expo/modules/audio/BaseAudioPlayer.kt:53-68`, gate at `:66-68` |

Magnitude: a 10 s stall on iOS credited as 10 s of watch time is
`r += 10/60 = 0.167` on a 60 s clip, Δcomposite `+0.05`, from nothing. On Android
the same stall contributes 0 — so **a cross-platform client that infers "playing"
from "status events are arriving" will under-count on Android and over-count on
iOS.** Gate on the store's explicit playing state, not on event arrival.

Per-tick credit ceiling: credit at most `min(elapsed, 1.5 × updateInterval)`. A
tick that arrives 8 s after the previous one has seen at most 0.5 s of playback
you can account for; anything beyond is a stall, a resume, or a device sleep.
`03-handoff.md` §4 already records that `updateInterval: 500` must not be lowered
for the same reason (a permanent 2 Hz bridge re-render loop) — the two
constraints pull in opposite directions and both are load-bearing.

---

**C8 — Never send more than one heartbeat per 5–6 s.**
Throttle: `telemetry: 60/min` (`settings.py:889`).

> **Correction to the research brief:** it cites "the client's 15 s minimum
> interval". There is no 15 s interval anywhere. The plan says **5 s**
> (`mobile-rebuild-plan.md:606, :761`) and the web client ships **6 s**
> (`player.tsx:134`). Both are safe; the table below is why either is.

| Interval | Sustained rate | vs. `telemetry: 60/min` |
|---|---|---|
| 5 s | 12/min | 20 % of budget |
| 6 s | 10/min | 17 % of budget |
| 1 s | 60/min | **exactly at the ceiling** — the 61st request in any 60 s window is a 429 |
| 500 ms | 120/min | 429 after ~30 s |

DRF's throttle is a **sliding window**, not a fixed one
(`rest_framework/throttling.py:110-129`): each accepted request inserts its
timestamp, expired entries are popped, and the cache entry's TTL is the scope
duration (60 s). So a 1 Hz client is refused starting at `t = 60 s`, not at some
aligned boundary.

`03-handoff.md` §7b task 3c already has this, and its trap note is right: a
**refused** request is not recorded (`allow_request` returns `throttle_failure`
before `throttle_success`), so a retry storm cannot deepen the hole — but it also
cannot escape it. Drop the oldest buffered event and continue.

---

**C9 — Latch on the first 403 from `log-telemetry` and stop permanently.**
Corrupts nothing; this is about not wasting the account's own telemetry signal.
The refusal is a property of the account (`is_minor` is written only at
registration — `serializers.py:984, :1002` — and mutated by no endpoint), and it
fires before the clip lookup (`views/interactions.py:158` vs `:168`), so it
carries no information about the clip. A single retry to distinguish a race is
harmless; a retry loop is not, because every attempt costs `telemetry: 60/min`
budget and eventually returns 429, which reads as rate limiting.
Surface it to the user once (`03-handoff.md` §7b task 3d) and keep `register-skip`
and `toggle-like` working — both are open to minors by explicit design
(`views/interactions.py:155-157`).

---

**C10 — Do not blind-retry `toggle-like`.**
Corrupts `UserInteraction.is_active` for `(user, clip, 'like')` — a double-tap the
user sees as "it flickered" is a permanent un-like, and there is no count to
reconcile against (§2.2).
**The existing 401-refresh-and-replay in `mobile/src/api/client.ts:314-322` is
safe here, and the reason is structural, so it is worth stating rather than
rediscovering:** DRF raises the 401 in `APIView.initial()`
(`perform_authentication`), which runs **before** `dispatch()` calls the action
handler. The toggle at `views/interactions.py:122-126` is never reached, so the
replay is the *first* execution of the toggle, not the second. The identical
reasoning makes the replay safe for all three actions.

What is **not** safe:

- replaying a request that returned 5xx or a network timeout — the first attempt
  may have committed;
- replaying a `register-skip` (idempotent in effect, but see C1/C3 — the retry is
  harmless, the *claim* may not be);
- replaying a `log-telemetry` whose 202 you never saw — a duplicate is silently
  dropped by `ignore_conflicts` (§6), so it is harmless, but only by accident.

---

**C11 — Send `reel_id` on every `register-skip`, and send `clip.id`.**
`reel_id` is `required=True` (`serializers.py:766`) and discarded
(`views/interactions.py:134-139`). Omitting it, or sending your own reel UUID, is
a permanent 400 on every skip. The comment sheet's "reply" affordance and the
reel card's clip id are the same UUID in this app; there is no second id space.

### 4.2 COURTESY

- **Back off on 429 using `Retry-After`.** DRF sets it from the throttle's own
  `wait()` (`rest_framework/exceptions.py:226-240`), so the header is exact, not a
  guess. `mobile/src/api/client.ts` already preserves the header on the thrown
  `ApiError`. Drop the oldest buffered telemetry event and carry on; do not block
  the UI.
- **Mint at most one playback token per clip switch.** `playback_token: 300/min`
  (`settings.py:928`) is generous but it is the tightest limit in the app and the
  one that bites hardest when exhausted — see the `player.tsx:625-635`
  post-mortem, where a stale `progress >= 0.99` re-armed the auto-advance once
  per second until 300/min refused every subsequent play.
  `src/lib/playbackTokenCache.ts` (600 s TTL, 120 s refresh margin) is the
  existing answer; keep using it, and do not call the endpoint from a per-frame
  effect.
- **`GET /feed/` is a destructive `lpop`.** `views/feed.py:75, :89` pop up to 10
  ids per request, so a re-request drains **more** of the queue rather than
  returning the same page. Buffer client-side (`mobile/src/lib/feedBuffer.ts`,
  60-item dedup cap) and never re-request a page you already have. A naive
  "retry on error" around `/feed/` permanently deletes feed inventory.

### 4.3 HYGIENE

- Send `Content-Type: application/json`. DRF's `JSONParser` 400s an unparseable
  body with a `detail` string worth logging verbatim.
- Use `hls_playlist_url` **verbatim**. Never prefix the API base onto it. The
  origin is the validating edge (`PUBLIC_HLS_ENDPOINT_URL`) and in `edge` style it
  is bucket-less (`AGENTS.md`, "Never construct a media URL client-side").
- Log the `correlation_id` from the response header on every 4xx/5xx. It is the
  only thing that lets an operator tie a client-side report to a server log line
  (`backend/EchoFlow/correlation.py`).
- Assert the **row**, not the status, in the integration test for telemetry. A
  202 with a dropped body (§2.1) is indistinguishable at the status level from a
  correct call.

---

## 5. The threat model: what a hostile or buggy client can do

All arithmetic below is from the code, with the derivation shown. Where the
research brief's numbers did not reproduce, the computed value is given and the
discrepancy is noted.

### 5.1 The completion cap is hard, and it is the most important number

`backend/app/services/counter_store.py:118, :125`:

```python
118:  COMPLETION_SAMPLE_CAP = 3
125:  COMPLETION_CAP_TTL_SECONDS = 86_400
```

Enforced atomically in Lua (`_CAP_SCRIPT`, `:219-231`): `GET` the budget, bail
with `0` if it is spent, else `INCR` and only then `INCRBYFLOAT` the sum and
`INCR` the count. The `used == 1` guard sets the TTL once per window, so the
window is anchored to the first write and is **not** slid forward by later
attempts.

The budget key is on the `completioncap:` prefix, deliberately **not** under
`clip:` (`:111`, and the comment at `:107-110`): `drain()` is `KEYS clip:*` + `DEL`
(`:148`, `:529`), so a key under `clip:` would be reset every 300 s beat and the
cap would be worth `3 × 288` samples/day instead of 3.

**Therefore: 10 000 skips and 3 skips on the same `(user, clip)` produce an
identical `avg_completion_rate` effect.** The other 9 997 requests are still
served with a 201 and still increment `AudioClip.skips` — but `skips` is a
display counter that **no ranking term reads**:
`_apply_engagement_velocity` recomputes from
`LEAST((likes + (shares * 2)) / …, 1.0)` (`tasks.py:1684-1687`). Only the first
3 samples move the 30 % term.

### 5.2 The blend is a constant-prior damper, not a fix

`tasks.py:1582-1588`:

```
1582: # Weight standing in for prior completion evidence when blending
1588: _COMPLETION_PRIOR_WEIGHT = 10
```

and the update at `tasks.py:1648-1651`:

```
acr' = (F('avg_completion_rate') * 10 + total_sum) / (10 + total_count)
```

`total_sum` / `total_count` are **one beat's** deltas; the previous value is
carried in the column. So per beat, per clip:

```
acr_{k+1} = (10 · acr_k + s_k) / (10 + n_k)
```

The comment at `:1581-1587` states the intent: *"the flusher drains Redis
counters and has no count of how many samples produced the value already on the
row"*. **There is no persisted sample count on `AudioClip`** —
`avg_completion_rate` is a bare `FloatField(default=0.0)` (`models.py:135`). The
prior is a constant, so it is a damper, not a Bayesian prior.

**Attacker-only traffic, 3 samples/day, `r = 1.0`, `acr_0 = 0`.** With the 3
samples landing in 3 separate beats — which is what pacing to the 24 h fixed
window gives — contraction per beat is `10/11`:

```
acr_k = 1 − (10/11)^k
(10/11)^90 = e^{90 · ln(10/11)} = e^{−8.5779} = 1.887 × 10⁻⁴
⇒ acr_90 = 0.999 81  after 30 days
```

For reference, putting all 3 in one beat gives `3/13 = 0.230 77` and contraction
`10/13` — **spreading is better for the attacker**, and it costs nothing.
Convergence to 1.0 is asymptotic, not capped.

**With honest traffic.** Let `H` be honest samples/beat at mean `m_h`. Summing
`(s_b − n_b · acr)/(10 + n_b) = 0` over every updating beat, the `10`s cancel
and the fixed point is the plain sample-weighted mean — **independent of how the
samples are grouped into beats**:

```
acr* = (3 · 1.0 + H · m_h) / (H + 3)
lift = acr* − m_h = 3/(H + 3) · (1 − m_h)
Δcomposite = 0.30 × lift          # feed_pool.py:152
```

| Honest `H`/day | `acr*` at `m_h = 0.5` | lift | **Δcomposite** | Δcomposite at `m_h = 0` |
|---|---|---|---|---|
| 200 | 0.507 39 | 0.007 39 | **+0.002 2** | +0.004 4 |
| 50 | 0.528 30 | 0.028 30 | **+0.008 5** | +0.017 0 |
| 5 | 0.687 50 | 0.187 50 | **+0.056 3** | +0.112 5 |
| 0 | 1.000 00 | 1.000 00 | **+0.300 0** | +0.300 0 |

> **The research brief's three figures (+0.0031 at H=200, +0.0788 at H=5, +0.297
> at H=0) do not reproduce from its own formula.** The formula
> `3/(H+3)·(1−m_h)` is correct and is what the code does; the table above is
> computed from it. The qualitative conclusion is unchanged and is in fact
> sharper at the top end: on a quiet clip **the attacker *is* the traffic**, and
> 3 samples/day on a clip nobody else watches takes a 30 %-weight term from
> wherever it was to a perfect score.

### 5.3 Rotating clip UUIDs multiplies this linearly, at no throttle cost

The throttle cache key is `throttle_<scope>_<user.pk>` — DRF
`throttling.py:238-249` concatenates the **scope** and the **user pk** and
nothing else. There is no clip id in it, and no clip id in the counter-store cap
key either (`completioncap:<clip_uuid>:user:<int>`, `counter_store.py:144`).

A client that walks a list of UUIDs therefore gets 3 fresh samples per UUID for
the same token cost. 500 requests over 167 UUIDs = 501 sample slots, 500 of them
land.

Two related facts:

- **Per-user keying makes the IP path unreachable on these endpoints.** All three
  actions are authenticated, so `ScopedRateThrottle.get_cache_key` takes the
  `request.user.pk` branch and never calls `get_ident`. The `anon: 100/hour`
  bucket they *also* inherit is IP-keyed, and it is protected here only by the
  `NUM_PROXIES: 1` backstop (`settings.py:852`) — this viewset uses the **bare**
  `ScopedRateThrottle` (`views/interactions.py:15, :185`), not
  `TrustedProxyRateThrottle`. Worth knowing if a second proxy is ever added.
- **`NUM_PROXIES` is irrelevant to the per-user buckets.** It only affects the
  `anon` ident.

### 5.4 Telemetry's damage is worse than skip's, and it is uncapped

Because the healthy telemetry path never calls `add_completion` (§1.2),
`COMPLETION_SAMPLE_CAP` **never engages for telemetry at all**. There is no
per-`(user, clip)` budget, no tolerance reward, nothing. Every accepted heartbeat
is a `UserInteraction` row whose `completion_rate` becomes `comp_weight` at
`recommendation.py:124` — with a 10× multiplier against the floor and no cap.

### 5.5 The 500-request budget

**`POST /interactions/{id}/register-skip/`, 500 requests, one account, 167 distinct clip UUIDs**

| | |
|---|---|
| Wall clock | **≈ 5 hours.** The binding bucket is `anon: 100/hour` (per IP, inherited via `DEFAULT_THROTTLE_CLASSES`, `settings.py:876-880`), not `interaction: 60/min` — which is why a "60/min" reading of this endpoint understates the cost by 30×. `user: 1000/hour` is not binding. |
| Cap | 3 per `(user, clip)` per 24 h window. Requests 4+ per clip still return 201 and still move `skips`; they contribute **no sample**. |
| Samples that land | **500** (3 each on clips 1–166, 2 on clip 167) |
| Δ`avg_completion_rate`, per clip | 3 samples at `r = 1.0` → `3/13 = 0.231` in one beat, `0.249` spread over three |
| Δcomposite, per clip | `0.30 × 0.23…0.25` = **+0.069 … +0.075** |
| The same 500 spent as 10 000 on one clip | identical 3 samples → identical Δ. The other 9 997 move only `skips`, which no ranking term reads. |
| `UserInteraction` rows | **167**, one per `(clip, user)` per beat, `interaction_type='view'`, `watch_time_ms=0`, `completion_rate=1.0` — `tasks.py:1845-1854` |
| Side effect | those 167 clip ids enter the 30-day `seen_ids` exclusion for this user (`recommendation.py:198-202`) — self-harm, and the reason rotation does not help the attacker here |

**`POST /interactions/{id}/log-telemetry/`, 500 requests, one account, 500 distinct clip UUIDs**

| | |
|---|---|
| Wall clock | **≈ 8.3 minutes.** `telemetry: 60/min` is the *only* throttle — see §5.7. |
| Cap | **none** |
| Samples that land | **500** — every one |
| Δ`avg_completion_rate` | **0.000 0.** Telemetry never calls `add_completion` on the healthy path. |
| Δcomposite via the 30 % term | **0.000 0** |
| Δcomposite via the **45 %** vector term | 500 rows at `comp_weight = 1.0` instead of the 0.1 floor — **10×** on 500 distinct clips' 384-d semantic + 128-d acoustic vectors in the user's own taste profile. Unbounded by any cap. |
| `UserInteraction` rows | **500**, `interaction_type='view'`, `completion_rate = 1.0`, `is_active = True` |
| Permanence | the next `calculate_time_decayed_vectors` reads them (`recommendation.py:84-146`) — on every `/suggestions/` and `/feed/`, and every 24 h via `evolve_long_term_user_baselines` (`tasks.py:610`) writing `long_term_semantic` / `long_term_acoustic` |

**The comparison, stated once: 500 skips buys +0.07 composite on 167 clips, for
5 hours. 500 heartbeats buys 0.000 0 on that same term, 10× weight on 500 clips
in the vector term, in 8 minutes — and it is the only one of the two that a
bystander cannot detect.**

### 5.6 The instant-skip penalty is dead for client skips

`record_skip`'s docstring claims the flusher materialises the row:

```
246:  The `flush_counters_to_pg` task materializes a single
247:  `UserInteraction(interaction_type='skip')` row per (user, clip)
248:  per beat with the aggregated completion_rate
```

`tasks.py:1848` writes `interaction_type='view'`. So `recommendation.py:130-131`'s
`−0.5` **never fires for a client skip**, and every client skip arrives as a
**positive** contribution to the user's taste vector at
`comp_weight = max(0.1, rate)`. The docstring is wrong; the behaviour is not a
bug, but a client that reasons about "the ranker will penalise my skip" is
reasoning about a code path that is unreachable.

### 5.7 `log-telemetry` escapes every global per-user throttle

`views/interactions.py:180-186`:

```python
180:  def get_throttles(self):
181:      # SECURITY: log_telemetry is the architecture audit's #1 abuse vector
184:      if self.action == 'log_telemetry':
185:          return [ScopedRateThrottle()]
186:      return super().get_throttles()
```

`get_throttles()` **replaces** the list; it does not extend it.
`DEFAULT_THROTTLE_CLASSES` (`settings.py:876-880`) is
`[AnonRateThrottle, UserRateThrottle, ScopedRateThrottle]`, so returning
`[ScopedRateThrottle()]` drops **both** `anon: 100/hour` and `user: 1000/hour`
for this action. The scope comes from the property at `:188-190`, which returns
`'telemetry'` — `60/min`.

**Net: `log-telemetry` is 3 600 requests/hour with no hourly ceiling, and it is
the one endpoint a comment at `settings.py:883-885` calls the architecture
audit's "#1 abuse vector (viewbot / engagement-velocity manipulation)".** The
override was written to make telemetry *tighter* than `interaction` — and its
actual effect was to remove the two hourly buckets. It is in fact the same
per-minute rate as `interaction` (`60/min`), so the override bought nothing on
the axis it was written for. This is the single largest unbudgeted surface in
the interaction API. The fix is one line
(`return super().get_throttles() + [ScopedRateThrottle()]` would restore
`user: 1000/hour` while keeping the 60/min scope), and it is **not fixed here** —
it is a backend change and the owner has said not to touch `backend/`
(`03-handoff.md` §7a).

---

## 6. The write-once trap, and the skip/telemetry collision

### 6.1 Write-once

`UserInteraction.Meta.unique_together = ('user', 'clip', 'interaction_type')`
(`models.py:269`), materialised by `migrations/0001_initial.py:289`, and the
consumer writes with `bulk_create(..., ignore_conflicts=True)`
(`tasks.py:1011-1013`), which compiles to `ON CONFLICT DO NOTHING`.

**A `'view'` row is write-once per `(user, clip)`.** Every heartbeat after the
first is discarded — and because the consumer's FK resolution drops unresolvable
users/clips *before* the insert (`tasks.py:949-999`, and the comment at `:943-948`
explaining why that is what makes `ignore_conflicts` safe), a row can never be
silently skipped for a data-corruption reason. The observed behaviour is
therefore:

- the first `view` payload to commit pins `watch_time_ms` and `completion_rate`
  for that `(user, clip)` **for ever**;
- the coalescer keeps the **last** payload per 10 s window
  (`coalesce_telemetry_latest`, `tasks.py:53-98`, which returns
  `(survivors, rejected)` and overwrites `survivors[key]` on each iteration) — so
  within a window the latest wins, but across windows the first commit wins;
- with the web client's 6 s cadence (`player.tsx:134`) a 300 s clip emits ~50
  heartbeats and **49 of them are no-ops**.

This is why C4 and C5 matter more than they look: the payload that lands first
is the payload that sticks, and if it is a `1.0` from a mis-attributed event, no
later honest heartbeat can correct it.

### 6.2 Two writers, opposite conflict semantics, one row

| Writer | Mechanism | On conflict |
|---|---|---|
| `flush_counters_to_pg` → `_materialize_user_interaction_rows` | `update_or_create(..., interaction_type='view', defaults={'completion_rate': mean, 'watch_time_ms': 0, 'is_active': True})` — `tasks.py:1845-1854` | **overwrites**, and hardcodes `watch_time_ms: 0` |
| `flush_telemetry_stream` | `bulk_create(..., ignore_conflicts=True)` — `tasks.py:1011-1013` | **silently discards** |

**A user who watches 30 s of a 60 s clip and then swipes fires both.** A
`register-skip` calls `add_completion` (`services/interactions.py:299`), which
the next 300 s beat drains and materialises as a `'view'` row with
`watch_time_ms = 0`. If the telemetry row committed first, the beat's
`update_or_create` **overwrites** it with `watch_time_ms = 0` and the mean
completion of the drained samples. If the beat committed first, the telemetry
`bulk_create` is **discarded** and the row keeps `watch_time_ms = 0`.

Either way: **a false skip permanently destroys the honest telemetry for that
clip**, and the row that survives feeds `recommendation.py:124` as `comp_weight`
and its existence feeds the 30-day `seen_ids` exclusion
(`recommendation.py:198-202`).

> **Hard client invariant: after a `register-skip` has been reported for a clip,
> send no further telemetry for that clip.** One `watch_time_ms = 0` overwrite is
> worse than a missing heartbeat, because the row is not merely stale — it is
> wrong, and nothing will ever revise it.

### 6.3 What the coalescer does and does not protect

`coalesce_telemetry_latest` (`tasks.py:53-98`) collapses per
`(user_id, clip_id, action_type)` per read window, last-wins, and coerces
`watch_time_ms` / `completion_rate` numerically so one malformed event is
rejected to the DLQ instead of raising `DataError` and taking the batch down.
That is a real protection **within** a window. It cannot see across windows, and
it cannot see the `update_or_create` writer at all. §6.2 is entirely outside its
reach.

---

## 7. Two prior-audit claims, resolved

`03-handoff.md` §7a listed these as "the two I most want to be sure about".

### 7.1 `bulk_create` without `ignore_conflicts` → batch loss — **REFUTED at HEAD**

`tasks.py:1011-1013`:

```python
1011:  UserInteraction.objects.bulk_create(
1012:      interactions, batch_size=500, ignore_conflicts=True,
1013:  )
```

`git log -S "ignore_conflicts=True" -- backend/app/tasks.py` returns exactly one
commit: **`a10fe14`**. The flag is present and the constraint it defends against
is real (`models.py:269` / `0001_initial.py:289`).

The **DLQ** is a different story and the finding is still partly open.
`TELEMETRY_DLQ_KEY = 'stream:interaction.events:dlq'` (`tasks.py:36`) is written
at `tasks.py:1064-1069` and the source entry is then **XACKed** (`:1068`), so
the payload is retrievable from the main stream only while it is under the 50 k
`STREAM_MAXLEN` (`services/interactions.py:91`). Its **only** reader is
`inspect_telemetry_dlq`, which is explicitly read-only. **There are zero
automated readers and zero automatic replay** — a DLQ entry is
manual-recovery-only, by design, and the code says so (`:1054-1061`: *"Nothing
replays automatically: whether DLQ'd telemetry is trustworthy is a product
decision"*).

The original claim now exists as a test: **27 regression tests** in
`backend/app/tests/test_telemetry_flush_integrity.py`, including
`test_one_duplicate_among_fifty_tenants_keeps_all_fifty` (`:389`) — one
conflicting row among fifty distinct users must not lose the other forty-nine.
Verified by count, not by running the suite in this pass.

### 7.2 Cache eviction of throttle keys by a telemetry flood — **premise true, conclusion wrong**

**Premise, confirmed at source level:**

- `CACHES['default']['LOCATION']` is `REDIS_CACHE_URL` (`settings.py:423`), i.e.
  the *cache* Redis.
- The consumer's dedup keys are `processed_event:{event_id}` with
  `nx=True, ex=dedup_ttl` and `dedup_ttl = 86_400` (`tasks.py:900-902`) — the same
  default cache, hence the same instance and DB index as the throttle keys
  (`throttle_<scope>_<ident>`, DRF `throttling.py:238-249`).
- That instance runs `--maxmemory-policy allkeys-lru` — `docker-compose.local.yml:93`
  (1 GB) and `docker-compose.yml:91` (3 GB). The *broker* is a separate instance
  on `noeviction` (`docker-compose.local.yml:71`, `docker-compose.yml:55`), so
  the two are provably not the same Redis.

> The research brief reports verifying the exact `LOCATION` value
> (`redis_cache:6379/0`) against a live container. No stack was running for this
> pass, so the *service name* is confirmed from compose and the *env
> interpolation* is taken from that brief rather than re-measured. It does not
> affect the argument: same instance either way.

**Why the conclusion does not follow.** LRU evicts the **least** recently used
key, and a dedup key is the **coldest key class in the database**: it is written
once (the `SETNX` at `tasks.py:901`), read once (the same line, on a
re-delivery), and then dormant for 24 hours. Under a telemetry flood the
*flood's own keys* are the freshest thing in the instance, so they are the last
to be evicted — the mechanism is **self-limiting**, not self-amplifying.
Throttle keys, by contrast, are read on **every** request through their scope and
re-written on every acceptance, so they sit at the hot end of the LRU list.

**What remains true is weaker, and is the honest statement:** LRU can hand a
currently-**idle** caller a fresh bucket, because eviction is indistinguishable
from expiry. So a user who has made no request for a long time is not rate
limited on their first request back. That is a real property, it affects every
caller equally, and it is not a feedback loop.

### 7.3 Unmitigated and real: `flush_counters_to_pg` has no retry and no transaction

`tasks.py:1483` (`flush_counters_to_pg`) → `tasks.py:1496`
`drained = counter_store.drain()`. `drain()` is `KEYS clip:*` + `DEL`
(`counter_store.py:148, :529`) — **irreversible**. Every apply path after it is
individually `try/except`-wrapped and only logs: `:1574-1578` (simple counters),
`:1654-1658` (completion), `:1762` (velocity), `:1856-1860` (row materialisation).
A worker killed between the drain and the last UPDATE destroys a whole beat of
counters with **no retry, no transaction, and one `logger.warning`**.

This is realistic rather than theoretical here: `docker-compose.local.yml` caps
`celery_media` at 2 GB, and this repo's own history records that container
OOM-ing (`AGENTS.md`, 2026-09-28 session learnings).

Compounding it: `[:batch_size]` = 500 truncation on all four apply paths silently
discards overflow **after** the keys have already been deleted, with no warning at
all. At 500 dirty clips per beat that is reachable on a small deployment.

**Neither is covered by a test.** Both are backend findings, outside this
document's authority to fix, and both belong on the same list as §5.7.

---

## 8. The related social & comment contracts

Phase 3 also builds the share sheet, the follow button and the comment sheet.
Verified, and brief — the detail is in the source; only the traps are tabulated.

### 8.1 Share (`ShareViewSet`, `views/social.py`)

| Endpoint | Contract |
|---|---|
| `GET /share/find-user/?username=X` | `200 {"id": <int>, "username": "<str>"}` — `views/social.py:191` |
| ↳ errors | `400 {"error": "Username required"}` (empty) · `400 {"error": "You can't share with yourself"}` · `404 {"error": "No user found: @X"}` · **`409`** on a case collision — `:185` |
| `POST /share/{clip_uuid}/send-share/` | `201 {"status": "shared successfully"}` — `:250` |
| ↳ errors | `400` missing `receiver_id` or self · `403 {"error": "This clip may not be shared"}` licence (`:244-248`) · `404` bad clip or receiver |
| `GET /share/inbox/` | **bare top-level array**, no envelope, no pagination — `:263-272` |
| `GET /share/` (list route) | `{count, next, previous, results}` — `DEFAULT_PAGINATION_CLASS` is `PageNumberPagination` |
| `GET /share/unread-count/` | `{"unread": <int>}` — `:275-277` |
| `POST /share/{share_uuid}/mark-read/` | `204` — `:258-260` |
| `POST /share/{share_uuid}/share-delete/` | `204` — `:253-255` |

**Three traps:**

1. **`id` is an INTEGER `User.pk`; `AudioClip.id` in the same flow is a UUID.**
   `ShareActionSerializer.receiver_id = IntegerField` (`serializers.py:769`) and
   the view does `get_object_or_404(User, id=receiver_id)` (`:167`).
   `get_object_or_404` catches only `Model.DoesNotExist`;
   `IntegerField.get_prep_value` re-raises the `ValueError` from a UUID string, so
   passing a clip UUID as `receiver_id` is an **unhandled 500**, not a 400. The
   mobile share sheet must take the `id` from `find-user` and pass nothing else.
2. **409 is a real, reachable answer and the web client does not handle it.**
   `User.username` is unique on a **case-sensitive** column, so `alice` and
   `Alice` are both storable and `iexact` matches both. The view slices at 2 and
   refuses rather than picking a winner (`:175-188`) — returning the lowest `pk`
   would deliver a share to whichever row was registered first, which is exactly
   the row a squatter controls. A mobile client needs a distinct 409 branch;
   "could not complete that search" is not an acceptable rendering of it.
3. **Not idempotent, and 204 means "nothing happened".** `services/shares.py:31`
   is an unconditional `ShareEvent.objects.create` — sending twice creates two
   inbox items. And `mark_read` / `share_delete` are
   `ShareEvent.objects.filter(pk=pk, receiver=request.user).update(...)` followed
   by an **unconditional** 204 (`:255, :260`), so a share that does not exist, or
   is not yours, returns the same 204. **An optimistic local delete is
   unrecoverable** — the server never contradicts you. Do not implement these as
   optimistic deletes.

Licence gating: sharing **your own** clip is allowed (the `creator == me` branch
is not licence-filtered on the send path — the filter at `:232-237` is
`status='ready' AND moderation_approved=True`, then `is_license_restricted`).
Sharing an NC or SA clip is **403**, by design, and the recipient's
`resolve_clip_access` also returns early for a sharee *before* the licence check
(`services/entitlements.py:108-110`) — so a *pre-existing* NC share remains
playable. That is an explicit design decision, not an oversight; the gate lives in
`send_share`, which is where the fix belongs.

### 8.2 Follow (`FollowViewSet`, `views/social.py:280-296`)

`POST /follow/{user_pk}/toggle-follow/`

| | |
|---|---|
| Success | **`201 {"status": "followed"}`** / **`200 {"status": "unfollowed"}`** — `:294` |
| Errors | `400 {"error": "You cannot follow yourself."}` · `404` · `429` |

- **Read the string, not the code.** 201 and 200 carry the *same* body shape, and
  the code is the only other signal; a client that branches on the status code
  alone will get one of the two states wrong.
- **A true toggle.** A double-tap silently unfollows. The only defence is
  hydrating `is_following` from the profile endpoint
  (`FeedClipSerializer.get_is_following`, `serializers.py:678+`).
- **`FollowViewSet` declares no `throttle_scope`** (`:280-296`), so
  `ScopedRateThrottle.allow_request` returns `True` immediately
  (`throttling.py:238-240`: *"If `view.throttle_scope` is not set, don't apply
  this throttle"*) and the only limit is `user: 1000/hour`. This is the exact
  footgun `AGENTS.md` records under `ScopedRateThrottle`: **listing the class
  without a scope is a silent no-op, not an error.**

### 8.3 Comments (`CommentViewSet`, `views/comments.py:108-213`)

Throttle: `comment: 60/hour` (`settings.py:911`).

> ⚠ **The `comment` scope is shared across all six actions** — list, retrieve,
> create, update, partial_update, destroy — because `ScopedRateThrottle` reads
> the scope from the *view*, and the view declares one scope for the whole
> viewset (`views/comments.py:111`). **Opening a thread, paging it, and posting
> on it all draw from the same 60/hour bucket.** A user browsing three threads at
> 20 results each uses 3 + 2 + 2 = 7; a user paging one thread ten times plus a
> post is at 11. There is no separate read budget.

**`GET /comments/?clip=<uuid>`** — `views/comments.py:190-197`

- Envelope: **Cursor** — `{"next": …|null, "previous": …|null, "results": […]}`.
  **No `count` key** (`CommentCursorPagination`, `views/_pagination.py:13-15`).
- Page size **20**, with **no `page_size` query override** — `CursorPagination`
  ignores one unless the class reads it, and this one does not.
- `next` is an **absolute URL** (`http://testserver/comments/?clip=…&cursor=…`).
  **Follow it verbatim**; do not rebuild the query string, and do not assume a
  relative path.
- `?parent=<uuid>` is a real filter (`filterset_fields`, `:121`) and returns
  **200 with empty `results`** for a parent that does not exist — *not* a 404.
- `?parent=null` is a **400**: django-filter derives a `UUIDFilter` from the model
  field and `translate_validation` surfaces the form error as a DRF
  `ValidationError`. *(Reasoned from the filter backend, not executed — no stack
  was running. Worth one test.)*
- An unknown or unreadable `clip` is **404**; a **malformed** `clip` is **400**
  (`:157-174`); an **empty** `?clip=` is **400** (same path — `''` fails UUID
  validation).
- Bare `GET /comments/` names no clip, so the `?clip=` check cannot run; the
  queryset is instead restricted to comments on readable clips (`:176-193`). It is
  walkable, by design and by documentation.

**`POST /comments/`** → `201`, body
`{id, clip, author_username, author_id, parent, text, reply_count, created_at}`
(`serializers.py:785`). The author comes from the token
(`views/comments.py:200-205` → `services/comments.py:24`) and **cannot be
spoofed** — `author` is not in `fields`.

**`PATCH /comments/{uuid}/`** → `200`. **`PATCH` with no `text` is a 500** —
`views/comments.py:210-211`:

```python
210:  def perform_update(self, serializer):
211:      comments_svc.update_comment(serializer.instance, text=serializer.validated_data['text'])
```

`validated_data['text']` is a direct subscript. On a partial update with no
`text` in the body the key is absent → `KeyError` → 500. **Always send `text`.**
Note the asymmetry with the serializer, which *does* declare a `validate_text`
(`serializers.py:793-811`) — it is simply never reached without the key.

- A non-author gets **404, not 403** (`get_queryset` scopes `update` /
  `partial_update` / `destroy` to `author=self.request.user`, `:187-193`, plus
  `IsAuthorOrReadOnly`, `:95-105`). Ownership is not leaked.
- `parent` and `clip` are **silently not writable on update** — they are not
  writable in `CommentSerializer`, so DRF drops them. A PATCH carrying `clip`
  will not move the comment.

### 8.4 The parent-validation defect — VERIFIED, and it blocks reply support

`services/comments.py:24`:

```python
24:  return Comment.objects.create(author=user, clip=clip, text=text, parent=parent)
```

No check that `parent.clip_id == clip.id`. There is no `CheckConstraint` and no
serializer `validate()`.

**The security consequence is bounded, and that is why this is a data-integrity
defect rather than a disclosure.** Every read path gates on the comment's *own*
clip — `get_queryset` filters `clip__in=self._readable_clips(user)`
(`views/comments.py:176-193`) and `_assert_clip_readable` checks the `?clip=`
value (`:157-174`). A reply filed under clip B but read via `?clip=B` is served;
read via `?clip=A` it is not. **No withheld content is disclosed.**

The damage is two-fold, and the first is exactly what the mobile comment sheet is
specified to copy:

1. **`get_reply_count` is unfiltered** (`serializers.py:788-791`):
   ```python
   788:  def get_reply_count(self, obj):
   789:      if not obj.parent_id:
   790:          return obj.replies.count()
   791:      return 0
   ```
   `obj.replies` carries no clip predicate. A parent on clip B reports replies
   that live on clip A — and those replies are **not retrievable** via
   `?clip=B`. A "show N more replies" affordance built on that count is
   **permanently unsatisfiable**: it opens a sheet that is empty by construction,
   for ever, for that thread.
2. **Deleting the parent CASCADE-deletes a comment filed under a different
   clip.** Someone else's comment on clip A disappears because a thread on clip B
   was removed.

`AudioClip.comment_count` is **not** corrupted: a reply has `parent_id` set, so
the model's `F()` bump (gated on `parent_id IS NULL`, `services/comments.py:1-8`)
never fires for it.

**Fix size:** ~5 lines in `services/comments.py::create_comment` (reject a
`parent` whose `clip_id` differs), **plus a separate fix to `get_reply_count`**
(add the clip predicate — the service fix alone still leaves existing rows
producing wrong counts), **plus a data-repair pass** for rows already written
wrong. It also flips the strict `xfail` in
`backend/app/tests/test_feed_and_comments_gates.py:743-770`
(`TestCrossClipParentIsUnenforced`, `xfail(strict=True, raises=AssertionError)` at
`:765`), which is the correct signal that the fix landed.

**Two adjacent defects matter more to a mobile client than the parent one:**

- **`PATCH {}` → 500** (above). A mobile client that does a "touch the comment
  to open the edit sheet" round-trip with an empty body 500s.
- **GDPR erasure inflates other people's `comment_count` permanently.**
  `services/erasure.py:222` is a bare `user.delete()`. That cascade-deletes
  `Comment` rows at the database level, so `Comment.delete()` — and with it the
  `F()` decrement on `AudioClip.comment_count` — **never runs**. Every erasure
  permanently over-counts the comments on every clip that user touched, in both
  the feed serializer and the profile endpoint. The fix is a pre-delete sweep
  through the service, not a `pre_delete` signal, because the signal would fire
  per row inside a cascade Django is already tearing down.

---

## 9. Corrections to the hand-off, the plan, and prior agent reports

Everything this research **disproved or refined**, with the correct version.
`03-handoff.md` §4 (player store defects) is unrelated, still stands, and is not
touched.

| # | Where | Belief | Correct version |
|---|---|---|---|
| 1 | `03-handoff.md` §7b; the framing of §1.1 above | The `0.99` figure reads as if it belonged to the skip guard. Task 3b's text names no threshold at all, and `0.99` appears only against **auto-advance** (task 3k, `plan:664`) | The skip guard is `position < duration × 0.9` **and** user-initiated (`plan:606, :762`). `0.99` is the advance trigger and must never produce a skip. Task 3b has no threshold to implement — §4 supplies it. |
| 2 | `03-handoff.md` §7a | *"`record_telemetry` uses `max(clip.duration_ms, 1)` while `record_skip` falls back to 60,000 — two different 'unknown duration' answers, one of them catastrophic."* | **Stale.** `a10fe14` unified them. One fallback (`60_000`) at `services/interactions.py:184, :216-217`, used by both paths. Guard: `test_ranking_exploit_cap.py:481-490`. §3. |
| 3 | `03-handoff.md` §7a | *"Confirm `UserInteraction.completion_rate` is write-only (the ranker reads `AudioClip.avg_completion_rate`), so telemetry cannot poison the recommender and `register-skip` is the only poison path."* | **Backwards.** The column is read at `recommendation.py:124` as `comp_weight` for the user's own 45 % vector term, floor 0.1, no cap. Telemetry *is* a poison path, and a less-bounded one. `register-skip` is the *better*-defended path (server-side divisor, tolerance band, 3/day cap). §1.2. |
| 4 | `03-handoff.md` §9, row "Backend P0s" | "reported; owner said do not touch `backend/`" — both, unaddressed | **Split.** The `bulk_create` batch-loss claim is **refuted** (`ignore_conflicts=True`, `tasks.py:1011-1013`, `a10fe14`; 27 tests in `test_telemetry_flush_integrity.py`). The cache-eviction claim is **premise-true / conclusion-wrong** (§7.2). And a **different, larger, genuinely unmitigated issue took their place**: `get_throttles()` on `log-telemetry` drops both hourly buckets for the endpoint the settings comment calls the #1 abuse vector (§5.7), *and* `flush_counters_to_pg` has an irreversible `drain()` with no retry and no transaction (§7.3). The row should be rewritten, not closed. |
| 5 | `03-handoff.md` §7c | `find-user` "→ `{id, username}` \| 404" | Incomplete. Also **400** (empty username, or yourself) and **409** (case collision), and `id` is an **integer** while `AudioClip.id` is a UUID — passing the wrong one is an unhandled **500**. §8.1. |
| 6 | `03-handoff.md` §7c | `send-share` "body `{receiver_id}` → 201" | Also **403** (licence-gated), **400** (missing / self), **404**, and **not idempotent** (`services/shares.py:31` is an unconditional `create`). §8.1. |
| 7 | `03-handoff.md` §7c | `mark-read` → 204 | 204 for a share that **does not exist or is not yours**. An optimistic local delete is unrecoverable. Same for `share-delete`. §8.1. |
| 8 | `03-handoff.md` §7c, task 3j | follow is just "POST" | Returns **201/200** with the *same* body shape — read `status`, not the code. True toggle, so a double-tap unfollows. **No `throttle_scope` on the viewset**, so `ScopedRateThrottle` silently allows everything. §8.2. |
| 9 | `03-handoff.md` §7b task 3h | "the list uses the **Cursor** envelope … with **no `count`**; edit is PATCH, delete is DELETE" | Correct — and `reply_count` (`serializers.py:788-791`) is the trap: it is unfiltered by clip, so a cross-clip parent makes it permanently unsatisfiable. `PATCH` with no `text` is a **500**. §8.3, §8.4. |
| 10 | `03-handoff.md` §7b task 3c | "`log-telemetry` is 60/min, so a sustained 1 Hz client 429s after ~60 s" | **Right.** The 429 is a sliding window (`throttling.py:110-129`), so t = 60 s exactly. But the plan's **5 s** and the web client's **6 s** are both safe; the brief's "15 s minimum interval" refers to nothing in the repo. §4 C8. |
| 11 | `03-handoff.md` §7b task 3e | "all three actions return bare objects, not envelopes" | **Right, and worth keeping.** `toggle-like` `200 {status}`, `register-skip` `201 {status}` (literal space), `log-telemetry` **202** {status}. None is paginated or enveloped. §2. |
| 12 | Research brief, §5 budget | "10 000 skips and 3 skips produce the identical `avg_completion_rate` effect" | True **per `(user, clip)`**; false as a global statement. The other 9 997 still return 201 and still move `AudioClip.skips` — which no ranking term reads. Also: the real 500-request cost is `anon: 100/hour` (**≈ 5 h**), not `interaction: 60/min`. §5.1, §5.5. |
| 13 | Research brief, §5 arithmetic | +0.0031 (H=200), +0.0788 (H=5), +0.297 (H=0) | Do not reproduce from the brief's own (correct) formula. Computed values in §5.2; the conclusion is *stronger* at the top end, not weaker. |
| 14 | Research brief, C7 | `ios/AudioPlayer.swift:474-489`, `BaseAudioPlayer.kt:52-69` | No first-party `mobile/ios/` or `mobile/android/` — the app is Expo managed. Real paths: `mobile/node_modules/expo-audio/ios/AudioPlayer.swift:474-491` and `mobile/node_modules/expo-audio/android/src/main/java/expo/modules/audio/BaseAudioPlayer.kt:53-68`. The **premises are confirmed**: iOS's periodic observer fires forever with a frozen `currentTime`; Android's `if (playing)` gate means it stops writing. §4 C7. |
| 15 | Plan defect 2 (`plan:474`) read as current state | "Natural completion fires `registerSkip` with `listen_duration_ms: 0`" | Correct **as a description of the old app**, and the old app is gone. But the *input* is still legal: `_completion_rate(0, clip) == 0.0`, not `None` (`:218, :225`). The rewrite must not reproduce it, and the server will not stop it. §3, §4 C3. |
| 16 | Research brief, §2 (not in any existing doc) | — | **New, since `c12f16b`:** all three interaction actions are scoped by `ClipInteractionViewSet.get_queryset()` (`views/interactions.py:105-119`). A clip outside scope is a **404**, not a 403. No mobile doc records this, and it changes the error table for all three endpoints. §2.1. |

### Not verified in this pass

Stated so no reader over-trusts the tables above:

- **No stack was running.** Nothing here was measured over HTTP. Every claim is
  read out of source at `a10fe14` + the working tree. The `?parent=null` → 400
  in §8.3 is *reasoned* from django-filter's `translate_validation`, not
  executed.
- **§7.2's exact `LOCATION` value** (`redis_cache:6379/0`) is taken from the
  research brief's live check. Source confirms `LOCATION = REDIS_CACHE_URL`
  (`settings.py:423`) and that the cache Redis is `allkeys-lru` while the broker
  is `noeviction` — which is all the argument needs.
- **Test counts are counted, not run.** 27 in
  `test_telemetry_flush_integrity.py`; the `xfail` at
  `test_feed_and_comments_gates.py:765` is read, not executed.
- **The suite was not run**, so this document makes no claim about the current
  pass/fail baseline. `AGENTS.md` records the last full measurement and the
  harness traps that make single runs untrustworthy.

---

## 10. What is left unfixed, and who owns it

Everything below is a `backend/` finding. The owner has said not to touch
`backend/` (`03-handoff.md` §7a), so none of it is fixed here. Listed in
descending order of damage.

| # | Issue | Location | Cost to fix |
|---|---|---|---|
| 1 | `log-telemetry` has **no hourly ceiling** — `get_throttles()` replaces `DEFAULT_THROTTLE_CLASSES` and drops `anon` and `user` | `views/interactions.py:180-186` | 1 line |
| 2 | `action_type` is client-controlled and is a live corruption primitive | `views/interactions.py:175` → `tasks.py:995` | 1 line (hardcode `'view'`) or drop the field |
| 3 | `flush_counters_to_pg`: irreversible `drain()` → no retry, no transaction, 500-item silent truncation | `tasks.py:1496, :1574-1578, :1654-1658, :1856-1860` | wrap the four apply paths in one `transaction.atomic`; re-`XADD` rather than `DEL` on failure |
| 4 | `Comment.parent` never validated against `parent.clip` | `services/comments.py:24` | ~5 lines **+** a `get_reply_count` fix **+** a data-repair pass; flips the strict `xfail` |
| 5 | `PATCH /comments/{id}/` with no `text` → 500 | `views/comments.py:210-211` | 1 line |
| 6 | GDPR erasure cascades comments without `Comment.delete()`, inflating other people's `comment_count` permanently | `services/erasure.py:222` | pre-delete sweep through the service |
| 7 | `FollowViewSet` has no `throttle_scope`, so `ScopedRateThrottle` is a silent no-op | `views/social.py:280-296` | 1 line + a rate |
| 8 | The telemetry DLQ has zero automated readers; entries are XACKed | `tasks.py:36, :1055-1068` | a product decision, not a bug |
| 9 | No persisted sample count on `AudioClip.avg_completion_rate`, so the blend prior is the constant 10 | `tasks.py:1582-1588`, `models.py:135` | a migration — `AGENTS.md` records the owner deferring this |
