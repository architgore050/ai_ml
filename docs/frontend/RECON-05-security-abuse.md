<task id="ses_f0f1f0b1fffemhWlSj4eWAfUQw" state="completed">
<task_result>
I have everything I need. Here is the report.

---

# RECON-05 — Security / Abuse

**Scope:** backend authorization (IDOR), input validation, injection, file upload, enumeration, rate limits, replay, frontend XSS sinks, CSP, client-side secret exposure.
**Mode:** read-only. No file created, modified or deleted. No git write. Suite not run (would write to the test DB) — so every claim below is source-derived, not execution-derived, and I say so where it matters.
**Baselines referenced, not re-derived:** 716 backend pass / 0 fail / 7 skipped; 48 frontend pass. `mobile/` and `docs/mobile/` untouched.

---

## 1. Findings summary

| ID | Area | Finding | Live? | Effort | Impact | Severity |
|---|---|---|---|---|---|---|
| R5-01 | Authorization | `GET /profile/{id}/clips/` has **no `moderation_approved` filter and no NC/SA filter** — the only clip-listing endpoint that omits both | **Live** | 1 GET | NC/SA + pre-moderation clip metadata + HLS edge URL published on a public page | **High** |
| R5-02 | Authorization | `ClipInteractionViewSet.queryset = AudioClip.objects.all()` — unscoped; like/skip/telemetry write against **any** clip UUID | **Live** | 1 POST × 60/min | Write-IDOR on another user's object; ranking poisoning of clips the attacker cannot see | **High** |
| R5-03 | Abuse / ranking | `record_telemetry` still computes `completion_rate` from a **client-supplied numerator**; 30% of the composite score | **Live** | 1 POST | Trivial, exact, no-manipulation-required inflation to 1.0 | **High** |
| R5-04 | Input / DoS | `POST /tags/initialize/` `selected_tags` is untyped and unbounded → 50 000 OR'd JSONB conditions; `int` → 500 | **Live** | 1 POST | Repeatable 30 s DB stall (1000/h); unauth'd-type 500 | **High** |
| R5-05 | Audit integrity | `X-Request-ID` is **not truncated** before `AuditLog.correlation_id` (`varchar(64)`); the insert is wrapped in `except: pass` | **Live** | 1 header | Attacker can **suppress the audit record for any request at will** | **High** |
| R5-06 | Input / DoS | Unauthenticated **500s** on `POST /legal/takedown/` and `POST /grievance/` (bad UUID, over-length `varchar`) | **Live** | 1 POST | Remote 500 per request from every IP; error oracle | **High** |
| R5-07 | Availability | `find_user` uses `get(username__iexact=…)` on a **case-sensitive** unique column; only `DoesNotExist` caught | **Live** | 2 registrations + 1 GET | Uncaught `MultipleObjectsReturned` → 500; username-squatting primitive | **High** |
| R5-08 | Abuse | `PATCH /clips/{id}/` mutates `title`/`category`/`license_type` on an **already-approved** clip; no re-moderation | **Live** | 2 requests | Post-moderation content swap in the live feed | **Medium** |
| R5-09 | Availability | `counter_store` drain uses blocking `redis.call('KEYS','clip:*')` on the cache Redis, every 5 min; keys have no TTL | **Live** | grow the keyspace | Blocks the single-threaded server holding **all** throttle buckets, `user_vectors:*`, `user_feed:*` | **Medium** |
| R5-10 | Disclosure | `/metrics/` is unauthenticated on the public origin and a test **pins** that | **Live** | 1 GET | Internal view-name inventory, DB/cache stats, throttle-feedback oracle | **Medium** |
| R5-11 | Abuse | `moderation_approved=True` is set **before** the check that can clear it; `public_view` trusts the flag alone | **Live** | 1 GET timed into the worker window | Unmoderated metadata public for the Whisper window | **Medium** |
| R5-12 | Abuse | `TakedownRequest.requester_email` and `Grievance.user_email` are attacker-supplied strings — no verification | **Live** | 1 POST | **Weaponised takedown** and **fabricated grievance** against a named third party, at 30/h and 10/h | **Medium** |
| R5-13 | Forensics | `Report.clip` and `TakedownRequest.clip` are `on_delete=CASCADE`; the accused can `DELETE /clips/{id}/` and destroy the complaint record | **Live** | 2 requests | Evidence destruction; breaks IT Rules R3(2) complaint retention | **Medium** |
| R5-14 | Authorization | `POST /clips/{id}/report/` uses unscoped `get_object_or_404(AudioClip, pk=pk)` | **Live** | 1 POST × 20/h | Clip-existence oracle; operator-queue pollution | **Low** |
| R5-15 | DoS | `redis.call('KEYS')` has no TTL on the counters it drains; `flush_counters_to_pg` failure ⇒ unbounded growth | Latent | induce task failure | Unbounded cache memory | **Low** |
| R5-16 | Availability | `media_worker_health` is `AllowAny`, unscoped, and opens a **new broker Redis connection per request**, closed only on the success path | **Live** | N requests | Broker connection churn; internal liveness disclosure | **Low** |
| R5-17 | Authorization | `LogoutView` blacklists **any** refresh token presented, without checking it belongs to `request.user` | **Live** | 1 POST | Cross-user forced logout (requires token possession) | **Low** |
| R5-18 | DoS | `?page=999999` deep OFFSET on every `PageNumberPagination` endpoint (20/page ⇒ ~20 M row skip) | **Live** | 1 GET | Bounded by `statement_timeout=30s`; repeatable | **Low** |
| R5-19 | DoS | Unbounded free-text into `Grievance.description`, `TakedownRequest.reason`, first-write `Report.content` from `AllowAny` endpoints | **Live** | 1 POST | Unbounded DB growth at 30/h and 10/h per IP | **Low** |
| R5-20 | Config | `docker/nginx/hls_auth.js` is a **19-line stub** but is still bind-mounted, and `docker-compose.yml:618` claims it gates `:9443`; `docker/nginx.conf:170` claims `hls/` is **public-read** (false) | N/A | operator action | Documented second auth layer does not exist; a stale comment says the bucket is public | **Low** (High if acted on) |
| R5-21 | Misrepresentation | `SECURITY.md` "Known Security Mitigations" claims emails are Fernet-encrypted at rest — the field was **removed**; email is plaintext | N/A | — | Published false control claim; DPDP-relevant | **Low** |
| R5-22 | Secrets | `backend/scripts/seed_clips.py:84` commits `DEFAULT_PASSWORD = "SeedLocal!2026"`; `:73` leaks `/mnt/dev-drive/my songs` | N/A | — | Scanner noise; possibly-live local credential | **Low** |
| R5-23 | Webhook | `REVENUECAT_WEBHOOK_SECRET` unset ⇒ `AllowAny` + **no verification, no 401**; and the HMAC is computed over `request.body` while the code comments say the signature is a header | Live-shaped, inert | — | Landmine for whoever implements Phase 2 | **Low** |
| R5-24 | Missing header | **No Content-Security-Policy on any origin** (backend, nginx, frontend, worker all absent) | N/A | — | Confirmed. Extends RECON-02 A-10: the API origin serves **rendered HTML** at `/clips/{id}/public/` | **Low** (no live XSS found) |

---

## 2. Authorization / IDOR audit

Every `ViewSet` / `APIView` in `backend/app/views/`, exhaustively.

| Endpoint | Class / file:line | Queryset scoped? | Ownership on mutation? | Verdict |
|---|---|---|---|---|
| `GET /feed/` | `FastFeedViewSet` `feed.py:60` | ids from `user_feed:{request.user.id}` | n/a (read) | **OK** — user-keyed, NC/SA excluded (`:115`) |
| `GET /suggestions/`, `/suggestions/{id}/` | `SuggestionViewSet` `feed.py:156` | `status='ready', moderation_approved=True, is_noncommercial=False, requires_share_alike=False` (`:183-187`) | n/a | **OK** |
| `POST /tags/initialize/` | `TagsViewSet` `feed.py:235` | n/a — writes only `request.user` | self only | **OK on ownership**, **broken on input** (R5-04) |
| `GET/POST /clips/` | `AudioUploadViewSet` `content.py:80`, `get_queryset` `:117-120` | `filter(creator=self.request.user)` | **OK** — create/retrieve/update/destroy/destroy all creator-scoped | **OK** |
| `PATCH/PUT /clips/{id}/` | `content.py:226-241` | creator-scoped | **OK**, but `title`/`category`/`license_type` writable post-approval | **R5-08** |
| `POST /clips/{id}/approve-moderation/` | `content.py:243-299` | owner-or-staff (`:272-279`) | **OK** since Group C | known limitation, see R5-11 |
| `POST /clips/{id}/report/` | `content.py:301-368` | **`get_object_or_404(AudioClip, pk=pk)` — unscoped** (`:314`) | `user=request.user` (`:345`, correct) | **R5-14** |
| `GET /clips/{id}/public/` | `content.py:370-401` | `filter(moderation_approved=True)` — **no `status`, no NC/SA** (`:394-396`) | n/a, `AllowAny` | **R5-11** |
| `POST /clips/{id}/share-link/` | `content.py:403-483` | owner-or-staff; then `moderation_approved` + `is_license_restricted` (`:445-458`) | **OK** | **OK** (fixed `3042f20`/`74c7ac9`) |
| `POST /clips/{id}/play/` | `content.py:485-583` | `moderation_approved=True` + `is_license_restricted` + `payload["c"] == clip_key` | anonymous; HMAC + per-clip scope | **OK** |
| `POST /interactions/{id}/toggle-like/` | `ClipInteractionViewSet` `interactions.py:24,28-33` | **`AudioClip.objects.all()`** | none | **R5-02** |
| `POST /interactions/{id}/register-skip/` | `interactions.py:35-47` | same unscoped queryset | none | **R5-02** |
| `POST /interactions/{id}/log-telemetry/` | `interactions.py:49-85` | same unscoped queryset | minor gate at `:65` | **R5-02** |
| `GET /share/`, `/share/{id}/` | `ShareViewSet.get_queryset` `social.py:84-94` | `filter(receiver=self.request.user)` | n/a | **OK** |
| `DELETE /share/{id}/` | `DestroyModelMixin` + scoped qs | receiver-scoped | **OK** (404 not 403) | **OK** |
| `DELETE /share/{id}/share-delete/` | `social.py:186-189` | `.filter(pk=pk, receiver=request.user)` | **OK** | **OK** |
| `POST /share/{id}/mark-read/` | `social.py:191-194` | same | **OK** | **OK** |
| `GET /share/inbox/`, `/share/unread-count/` | `social.py:196-211` | `filter(receiver=request.user)` | n/a | **OK** |
| `GET /share/find-user/` | `social.py:114-125` | `get(username__iexact=…)` — **500 on case collision** | n/a | **R5-07** |
| `POST /share/{id}/send-share/` | `social.py:127-184` | `status='ready', moderation_approved=True` (`:166-172`) + `is_license_restricted`; `receiver_id != self` | `receiver` from body — **that is the point of the endpoint**, and self-share is rejected (`:159-163`) | **OK** |
| `POST /follow/{id}/toggle-follow/` | `social.py:221-229` | `get_object_or_404(User, pk=pk)` | self-follow 400 (`:224`) | **OK** |
| `GET/POST/PATCH/DELETE /comments/` | `CommentViewSet` `comments.py:54-64` | reads global; writes `filter(author=request.user)` | **two layers**: `get_queryset` + `IsAuthorOrReadOnly` (`:27-37`) | **OK** — N1 correctly fixed |
| `GET /profile/me/`, `PATCH /profile/me/update/` | `profile.py:29-43` | `request.user` only | self | **OK** |
| `GET /profile/{id}/` | `profile.py:45-55` | any `User` by pk — public by design; no `is_active`/`is_staff` filter | n/a | **OK** (enumeration noted in §6) |
| **`GET /profile/{id}/clips/`** | `profile.py:57-78` | **`filter(creator=target, status='ready')` only** (`:66-74`) | n/a | **R5-01** |
| `GET /profile/me/` liked clips | `OwnProfileSerializer.get_liked_clips` `serializers.py:796-835` | `userinteraction__user=obj` where `obj == request.user` | self | **OK** |
| `POST /media/playback-token/{clip_id}/` | `PlaybackTokenView` `media.py:201-284` | `moderation_approved` (`:213`) + `resolve_clip_access` (`:228`) | token-derived | **OK** (A4 closed) |
| `GET /data-subject/access/` | `data_subject.py:19-45` | `request.user` | self | **OK** |
| `POST /data-subject/erasure/` | `data_subject.py:52-129` | `filter(user=user, request_type='erasure')` | self | **OK** — I checked the re-arm concern; `if existing:` returns in **both** branches before the reset, so `cooling_off_until` is **not** re-armable. **Disconfirmed** (§15) |
| `GET /legal/compliance/` | `legal.py:9-52` | settings | n/a | **OK** (IT Rules mandate) |
| `POST /legal/takedown/` | `legal.py:55-88` | `AudioClip.objects.get(id=clip_id)` — unscoped, **no `status`/moderation filter** | `requester_email` from body | **R5-06**, **R5-12** |
| `POST /grievance/` | `grievance.py:9-40` | `CreateAPIView`, no list route | `user_email` from body | **R5-06**, **R5-12** |
| `GET/POST /subscription/`, `/subscription/sync/`, `/subscription/manage/` | `subscription.py:49-103` | `request.user` | self | **OK** |
| `POST /webhooks/revenuecat/` | `subscription.py:106-148` | `AllowAny`, no user | n/a | **R5-23** |
| `POST /auth/logout/` | `urls.py:62-78` | refresh token from body, **not checked against `request.user`** | — | **R5-17** |
| `GET /api/v1/health/media-worker/` | `system_health.py:20-44` | `AllowAny`, no scope | n/a | **R5-16** |
| `GET /metrics/` | `EchoFlow/urls.py:16` | no auth at all | n/a | **R5-10** |
| `GET /health/`, `/ready/` | `EchoFlow/health.py` | no auth | n/a | **OK** by design |

### 2.1 R5-01 — `GET /profile/{id}/clips/` is the only clip-listing endpoint that omits both gates

`backend/app/views/profile.py:66-74`:

```python
clips = (
    AudioClip.objects
    .filter(creator=target, status='ready')
    .annotate(user_has_liked=Exists(user_like_subquery))
    .annotate(**following_annotation(request.user))
    .order_by('-created_at')
)
```

Every other clip-listing path in the repo applies both `moderation_approved=True` **and** `is_noncommercial=False, requires_share_alike=False`:

- `feed.py:111` + `:115` — primary feed
- `feed.py:135-137` — feed degraded fallback
- `feed.py:183-187` — `/suggestions/`
- `social.py:166-172` — `send_share` (`status='ready', moderation_approved=True`)
- `social.py:394-396` — `public_view` (`moderation_approved=True`)

`profile.py` has neither. `FeedClipSerializer` is used, so each leaked row carries `id, title, creator_name, creator_id, category, hls_playlist_url, likes, shares, skips, comment_count, tags, duration_ms, cover_image` (`serializers.py:395-410`).

**Request:** `GET /profile/{victim_id}/clips/` with any valid access token.
**Observable:** rows for `is_noncommercial=True` / `requires_share_alike=True` clips — content `feed.py`, `social.py:173`, `content.py:450` and `content.py:533` all deliberately withhold — are returned in full, including the token-gated `hls_playlist_url`. Audio is *not* playable (the edge still needs a token, and `resolve_clip_access` would deny), so this is a **licensing-metadata + catalogue disclosure and a feed-consistency violation**, not a playback bypass. It is still the exact gap the A4 work closed everywhere else.

**Test:** create `is_noncommercial=True, status='ready', moderation_approved=True` and `moderation_approved=False, status='ready'` clips; assert `GET /profile/{owner}/clips/` returns neither. Neither assertion exists today — `test_adversarial_pass3.py:454-471` only inspects the **source text** for the `user_has_liked` annotation, and `test_is_following.py:349-357` only asserts `is_following` is present.

`status='ready'` is **not** a substitute for `moderation_approved=True`: nothing in the codebase ever revokes approval (no un-approve route; `content_moderation.py:177` is the only writer and only ever sets it from a fresh check), so once approved a clip is approved forever — and `process_audio_to_hls` sets `status='ready'` after the worker check, so a clip can be `ready` and then have `moderation_approved` flipped to `False` by a *retry* of the task.

### 2.2 R5-02 — unscoped `ClipInteractionViewSet`

`backend/app/views/interactions.py:23-26`:

```python
class ClipInteractionViewSet(viewsets.GenericViewSet):
    queryset = AudioClip.objects.all()
    permission_classes = [permissions.IsAuthenticated]
    throttle_scope = 'interaction'
```

`self.get_object()` at `:30`, `:37` and `:75` resolves against `all()`. This is precisely the defect Group C fixed in `approve_moderation` (`content.py:250-256` documents the same `get_object_or_404(AudioClip, pk=pk)` → scoped pattern) — it was never applied here.

**Request:** `POST /interactions/{any_clip_uuid}/register-skip/` `{"listen_duration_ms": 99999, "reel_position_ms": 1, "reel_id": "<uuid>"}`.
**Observable:** a `completion` sample and a `skips` increment land on a clip the caller has no entitlement to, including one that is `moderation_approved=False` and therefore invisible in every feed. `record_skip` → `counter_store.add_completion` + `increment('skips')` (`interactions.py:225-227`) → `flush_counters_to_pg` → `AudioClip.avg_completion_rate` and `engagement_velocity`, which are **30% and 25% of the composite score** (`feed_pool.py:151-153`, `:224-226`). So the write-IDOR is also a ranking-poisoning primitive against unpublished content.

`_has_interaction` in `entitlements.py:143-153` is *not* an amplifier: `resolve_clip_access` checks `is_license_restricted` at `:112` **before** `_has_interaction` at `:118`, so forging an interaction does not unlock an NC clip's audio. The exploit is ranking, not playback.

**Test:** `clip_b` with `moderation_approved=False`; `auth_client.post(f'/interactions/{clip_b.id}/register-skip/', …)` → assert 404, and assert `UserInteraction.objects.filter(user=user, clip=clip_b)` is empty.

### 2.3 Client-supplied identity fields

| Field | Where | Derived from token? |
|---|---|---|
| `Report.user` | `content.py:345` | **yes** — `request.user`, with a comment explaining why |
| `ShareEvent.sender` | `services/shares.py:31` | **yes** — `sender` argument, from `request.user` at `social.py:183` |
| `ShareEvent.receiver` | `social.py:153-164` | body `receiver_id` — correct by design; self-share rejected at `:159-163` |
| `Comment.author` | `serializers.py:552` | **yes** — `context['request'].user` |
| `AudioClip.creator` | `serializers.py:368` | **yes** — `context['request'].user` |
| `FollowViewSet` actor | `social.py:227` | **yes** — `request.user` |
| `Grievance.user_email` | `grievance.py:31` | **NO** — `data.get('user_email')` accepted from an anonymous caller |
| `TakedownRequest.requester_email` | `legal.py:71,81` | **NO** — verbatim from body, no email validation |
| `report_clip.title` / `content` | `content.py:338, 349` | body, but `content` is **not truncated on first write** (`'content': content` vs `'title': title[:200]` one line above) |
| `SkipActionSerializer.reel_id` | `serializers.py:507` | required but **never read** by `register_skip` (`interactions.py:41-46`) — dead field |
| `reel_position_ms` | `serializers.py:506` | accepted and discarded by the fixed arithmetic (`_completion_rate` no longer takes it) — **now dead**; a client still sending it gets no error and no effect |

No endpoint derives an acting identity from a body field. The two regulatory endpoints accept a *claimed third-party* identity, which is the R5-12 problem.

---

## 3. Input validation & injection

### 3.1 Raw SQL / string-formatted queries

Only three production sites, all safe:

- `backend/EchoFlow/health.py:28-29` — `cursor.execute("SELECT 1")`, no interpolation.
- `backend/app/tasks.py:1479-1495` — the only f-string SQL. `table = AudioClip._meta.db_table` (`:1466`), i.e. from Django's model meta, not user input. Values are bound: `WHERE id = ANY(%s::uuid[])` with `params = [uuid_objs]` (Postgres branch), or `?`-placeholders with `params = [u.hex for u in uuid_objs]` (SQLite branch). `uuid.UUID(str(c))` at `:1459-1463` rejects anything non-UUID before it reaches the query. **No injection.**
- Everything else in `backend/app/tests/` (f-string `EXPLAIN` at `test_integration_pgvector.py:121` — test-only, not reachable).

`.extra()` and `RawSQL`: **zero occurrences** in the tree.

### 3.2 Unbounded / untyped serializer and view fields

| Field | Site | Bound | Problem |
|---|---|---|---|
| `Grievance.subject` | `grievance.py:28` → `models.py:333` `max_length=200` | none | >200 chars ⇒ `StringDataRightTruncation` ⇒ **500** (unauth) |
| `Grievance.description` | `grievance.py:29` → `TextField` | none | unbounded storage, unauth |
| `Grievance.user_email` | `grievance.py:31` → `EmailField` (varchar 254) | none | >254 ⇒ **500** (unauth) |
| `TakedownRequest.reason` | `legal.py:73` → `TextField` | none | unbounded storage, unauth |
| `TakedownRequest.requester_email` | `legal.py:71` → `EmailField` | none, **and not validated as an email** | >254 ⇒ **500**; `TakedownRequest.objects.create` bypasses every serializer |
| `clip_id` on takedown | `legal.py:75` `AudioClip.objects.get(id=clip_id)` | none | non-UUID ⇒ `django.core.exceptions.ValidationError` ⇒ **500**; only `AudioClip.DoesNotExist` is caught (`:76`) |
| `Report.content` (first write) | `content.py:349` | **none** — the append path caps at 4000 (`:359`), the create path does not | unbounded on create |
| `Report.title` | `content.py:338,348` | `[:200]` ✔, but `title = request.data.get('title')` may be an int/dict from a JSON body ⇒ `title[:200]` raises `TypeError` ⇒ 500 | type confusion |
| `selected_tags` | `feed.py:246` | **none, untyped** | see R5-04 |
| `category` (suggestions) | `feed.py:180,189` | none | `re.sub(...)[:32]` at `:203` bounds only the *metric label*, not the ORM filter — a 10 KB `?category=` reaches `AudioClip.category` (varchar 50) as a comparison value; no error, just a scan bounded by `statement_timeout=30s` |
| `Comment.text` | `serializers.py:534-549` | 500 (model) ✔ | control chars stripped, NUL rejected; **HTML is not stripped** — correct, it must render as text |
| `report_reason` | `content.py:317-326` | enum ✔ | `sorted(valid_reasons)` is echoed to the client — fine, it is a public constant |

**Mitigations that are present and correct:** `AUTH_PASSWORD_VALIDATORS` all four (`settings.py:466-481`) — though see RECON-02 A-2 that `validate_password` is never *called*; `dob` bounds with `timedelta` arithmetic, not `date.replace` (`serializers.py:659-662`); `watch_time_ms` capped at 36 000 000 (`serializers.py:561`); `copyright_acknowledgement` required (`serializers.py:230-232`); `FileField`/`ImageField` content validated by a real Pillow decode plus an explicit 5 MB cap (`serializers.py:861-887`).

### 3.3 Subprocess / command injection

`grep -rn "shell=True"` over `backend/` + `ai_ml/` excluding tests: **0 hits**. `os.system` / `os.popen`: **0**. `eval(`: **0**.

The three `subprocess.run` sites all use a **list** argv, no shell:
- `tasks.py:145-149` — `['ffmpeg','-y','-i',input_file_path,'-ac','1','-ar',str(sr),'-f','wav',wav_path]`, `input_file_path` from `tempfile.mkstemp` (`tasks.py:207`).
- `tasks.py:361-368` — HLS encode, `normalized_path` from `tempfile.mkstemp` via `normalize_to_wav` (`tasks.py:141-144`).
- `ai_ml/scrapers/normalizer.py:58,153` — `pydub.AudioSegment.from_file`, which shells out to ffmpeg internally with a list.

No attacker-controlled string reaches an argv position. **No command injection.**

### 3.4 SSRF

Every outbound HTTP call uses a **hardcoded** host; no user input reaches a URL:

- `services/revenuecat.py:22` — `REVENUECAT_API_BASE = "https://api.revenuecat.com/v1"`, constant. `get_subscriber_info` interpolates only a `uuid4` (`models.py:60`).
- `ai_ml/scrapers/sources/*.py` — `freesound.py:27`, `wikimedia_commons.py:38`, `internet_archive.py` all use module-level constants.
- No avatar-by-URL fetch, no oEmbed, no metadata fetch. `profile_picture` is upload-only.
- `PublicProfileSerializer.get_profile_picture_url` / `OwnProfileSerializer.…` call `get_signed_media_url` (`media_urls.py:88-113`) with a **DB-stored** key, not a request value.

**No SSRF.**

### 3.5 Path traversal in file serving

`grep -rnE "static\.serve|FileResponse|sendfile|X-Accel"` over `backend/`: **1 hit, and it is a comment** — `app/urls.py:103`, explaining why such a route deliberately does not exist. There is no Django file-serving route. The `:8005` debug escape hatch in `docker-compose.yml` publishes gunicorn, not `django.contrib.static`.

The only user-influenced path reaching storage is `upload_to='uploads/%Y/%m/%d/'` (`models.py:114`), which Django's `Storage.get_available_name` + `validate_file_name` normalise.

**The HLS edge is traversal-safe, and the reason is load-bearing.** `workers/hls-token-worker/src/index.ts`:

```ts
const url = new URL(request.url);
...
if (!url.pathname.startsWith("/hls/")) { return new Response("Not found", {status:404}); }
...
const objectKey = url.pathname.slice(1);
```

`url.pathname` is the output of the WHATWG URL parser, which **removes dot-segments before the prefix test ever runs**. So `GET /hls/<clip>/../../uploads/secret` normalises to `/uploads/secret` and is rejected by the prefix check, and `GET /hls/<clip>/../<other-clip>/master.m3u8` normalises to `/hls/<other-clip>/…` and fails the token scope check (`token.ts:130-132`). This is correct but **completely unpinned by a test** — an `index.ts` test asserting that a `?s=`-equivalent token for clip A cannot read `hls/B/…` via dot-segments is the assertion that keeps it correct if anyone ever switches to `request.url` raw-string slicing.

**Recommendation (defence in depth, not a live bug):** add an explicit `objectKey.includes('..')` / `path.posix.normalize` assertion in the Worker, and a test.

### 3.6 The one rendered-HTML surface

`content.py:43-77` `_render_share_card` is the only server-rendered HTML in the codebase. Every interpolation goes through `django.utils.html.escape`:

```python
title = escape(str(data.get("title") or "EchoFlow clip"))
creator = escape(str(data.get("creator_name") or ""))
description = escape(f"{data.get('category') or 'audio'} clip by {creator}".strip())
image_tag = (f'<meta property="og:image" content="{escape(str(image))}">' if image else "")
...
url = request.build_absolute_uri(request.path)   # escaped at :71
```

`escape()` defaults to `autoescape=True` and covers `< > & " '`, which is exactly the set needed inside `content="…"` and inside `<title>`/`<h1>`/`<p>` text. `request.path` is Django-normalised, not attacker-controlled beyond the path itself, and it is escaped anyway. **No XSS here.** The residual gap is that this page is served with **no CSP** (R5-24) and nginx's `X-Frame-Options: DENY` is the only thing preventing it being framed.

---

## 4. File upload abuse

**Audio (`POST /clips/`).** Three independent layers, all server-side:

1. `AudioUploadSerializer.MAX_SIZE = 100 * 1024 * 1024` (`serializers.py:195`), checked at `:279-280` — for Pro and free alike.
2. Free-tier cap `REVENUECAT_UPLOAD_MAX_SIZE_MB_FREE` (default 10 MB) at `:271-276`, applied in `validate()` via `self._enforce_free_limits` when `not request.user.is_pro()`.
3. `nginx` `client_max_body_size 100m;` (`docker/nginx.conf:47`, `docker/nginx.local.conf:20`) — matches the serializer cap, so nginx rejects first with a 413 rather than streaming 100 MB into Django.

Plus: extension allowlist of 8 audio extensions (`:194`, checked `:281-283`); a 20-entry pure-Python magic-byte denylist (`:31-73`, checked `:292-299`); a libmagic second layer (`:307-319`); and a **pydub duration probe** at upload time (`:337-363`) that reads the whole file into memory and rejects anything over `MAX_DURATION_SECONDS` (300) *before* it reaches S3 or the worker.

**The gaps:**

- **The duration probe is a memory-amplification vector.** `serializers.py:341-345` does `data = value.read()` then `AudioSegment.from_file(io.BytesIO(data))`. A 100 MB upload becomes a 100 MB `bytes` **plus** a fully decoded PCM buffer (100 MB of 16-bit stereo ≈ 100 MB more, and `AudioSegment.from_file` without a format hint decodes at the source rate) inside a gunicorn worker. With `GUNICORN_THREADS` default 4, four concurrent 100 MB uploads is ~1 GB of RSS in the web container. The `HACK`/`TODO` at `:331-336` acknowledges this. It is bounded by `MAX_SIZE` and the `upload` 20/hour scope, so it is a memory-pressure risk, not an OOM.
- **`REVENUECAT_CLIP_DURATION_LIMIT_FREE` (60 s) is never enforced.** `serializers.py:338` reads `MAX_DURATION_SECONDS` (300) for everyone; `REVENUECAT_CLIP_DURATION_LIMIT_FREE` has **no reader** outside `subscription.py:33` where it is only *reported* to the client as a limit. Same for `REVENUECAT_HD_QUALITY_BLOCKED_FREE` — read only at `subscription.py:35` for display. This is already tracked in `docs/EXPLAIN/decisions/2026-09-29-unenforced-subscription-limits.md` and I am **not** re-reporting it as new; flagging only that the API **advertises** limits it does not enforce, which is the worse half.
- **The daily free-tier count is not atomic** (`content.py:200-203`, `subscription.py:43-45`): `SELECT COUNT(*) … WHERE created_at::date = today`. Two concurrent uploads on the last free slot both see `4 < 5` and both proceed. Needs a partial unique index or an advisory lock. The real cap is the 20/hour `upload` scope, so the exposure is 1 extra upload/day.
- **`cover_image` is never writable through the API** — `AudioUploadSerializer.Meta.fields` (`:236`) omits it, and `ProfileUpdateSerializer` only handles `profile_picture`. So there is no path to set it; `get_cover_image` reads a column nothing in the app writes. Dead surface, not a hole.

**Avatar (`PATCH /profile/me/update/`).** `ProfileUpdateSerializer.MAX_SIZE = 5 MB`, `ALLOWED_EXT = {jpg,jpeg,png,webp}` (`serializers.py:861-887`). The docstring's reasoning is correct and I verified it: `User.profile_picture` is `models.ImageField` (`models.py:55`), so DRF's `ImageField` runs a real Pillow `Image.open()` + `verify()` — a renamed `evil.exe` cannot pass. The explicit cap is the whole fix. `DATA_UPLOAD_MAX_MEMORY_SIZE` correctly does **not** apply (uploads spool to a temp file), as the docstring says.

**Net verdict:** the upload path is the best-defended surface in the repo. The two real items are the 2× memory amplification in the duration probe, and the fact that `/clips/{id}/` (`GET`) returns a **1-hour presigned `uploads/` URL** for the caller's own clip (`AudioUploadSerializer` includes `original_file`; `STORAGES.querystring_expire=3600` at `settings.py:629`), which means the private original is reachable from any client-side log or error reporter that captures response bodies.

---

## 5. XSS (frontend sinks + CSP status)

### 5.1 Sinks — all clear

Run over `frontend/src/` (36 tracked files, `git ls-files frontend`):

| Sink | Result |
|---|---|
| `dangerouslySetInnerHTML` | **0** |
| `innerHTML` / `outerHTML` / `insertAdjacentHTML` | **0** |
| `document.write` | **0** |
| `eval(` / `new Function` | **0** |
| `setTimeout("…")` / `setTimeout('…')` (string form) | **0** |
| `srcdoc` / `createContextualFragment` | **0** |
| `target="_blank"` | **0** — so the missing-`rel="noopener"` class of bug has **no instances** |
| `rel=` (any) | **0** |
| `href={…}` / `src={…}` from user data | 2 hits, both inert: `Profile.tsx:148` and `Header.tsx:161` put a server-supplied `profile_picture` URL into `<img src>`. A `javascript:` URL in `<img src>` does not execute in any current browser, and the value is a presigned S3/MinIO URL built by `get_signed_media_url` (`media_urls.py:88`), never raw input. |
| `window.location` / `location.href` / `window.open` | 3 hits, all benign: `ReelList.tsx:57` and `ErrorBoundary.tsx:111` call `window.location.reload()` with no argument; `ShareModal.tsx:34` builds `` `${window.location.origin}/?clip=${clip.id}` `` where `clip.id` is a `uuid4` from the API, not free text. |
| `mark_safe` / `\|safe` (Django templates) | **0** |
| `format_html` / `Template(` | **0** |

`CommentSheet.tsx` renders comment bodies as React children, which auto-escapes. `CommentSerializer.validate_text` strips control characters and rejects NUL (`serializers.py:534-549`) but deliberately leaves HTML alone — correct, because React escapes it and server-side HTML stripping would be the wrong layer.

**Conclusion: no XSS sink exists in the shipped frontend.** The residual risk is entirely R5-24 (no CSP) plus a hypothetical future `dangerouslySetInnerHTML`.

### 5.2 CSP — confirmed absent, everywhere

```
grep -rn "Content-Security-Policy|contentSecurityPolicy|helmet|CSP_"
  --include=*.py --include=*.conf --include=*.ts --include=*.tsx
  --include=*.json --include=*.html --include=*.yml
  backend docker frontend workers          →  0 hits
```

`add_header` directives actually present:

- `docker/nginx.conf:108-111` — `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`
- `docker/nginx.local.conf:83-86` — the same four
- `settings.py:906` `SECURE_CONTENT_TYPE_NOSNIFF = True` (under `if not DEBUG`)

No `Content-Security-Policy` and no `Permissions-Policy` on **any** origin: the API origin, the `:9443` media origin, the Worker (`index.ts` `corsHeaders()` sets only CORS headers), or the frontend (`index.html` has no `<meta http-equiv="Content-Security-Policy">`; the production host is Cloudflare Pages, which reads `_headers` / `wrangler.toml` — neither exists in this repo).

**Extends RECON-02 A-10** with one surface that recon could not have seen, because it only audited the React bundle: the **API origin serves rendered HTML** at `GET /clips/{id}/public/` (`content.py:401`, `HttpResponse(_render_share_card(...), content_type="text/html")`), unauthenticated, to any chat client that unfurls a share link. It is fully escaped today (R5-06 §3.6), so there is no live XSS — but it is a same-origin HTML surface on `api.echoflow.in` where tokens are minted, with no CSP, in a product whose production topology is deliberately cross-origin (`app.echoflow.in` → `api.echoflow.in`).

Also absent: `X-XSS-Protection` (correctly deprecated) and `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy` (the `ef_hls_token` cookie is `SameSite=Lax`, so COOP/COEP are defence in depth, not requirements).

### 5.3 The HLS cookie is the highest-value XSS target — and it is well defended

`media.py:256-283` sets `ef_hls_token` with `httponly=True, secure=True, samesite="Lax", path="/hls/"`. `HttpOnly` means script cannot read it; `Secure` means it will not be set over the dev HTTP stack; `Lax` (not `Strict`) is required for hls.js's top-level navigation. **The design is right.** With no CSP, a single successful XSS elsewhere could not exfiltrate this cookie directly — it could only issue authenticated `fetch` calls, which is a materially smaller blast radius. That is a real (if accidental) mitigation and should be recorded as such.

---

## 6. Enumeration

| Surface | Behaviour | Verdict |
|---|---|---|
| `GET /share/find-user/?username=X` | `social.py:114-125`. **200 + `{id, username}`** on hit, **404 + `No user found: @X`** on miss — two distinguishable shapes, and the PK is returned. Throttle `share_poll` = 1000/hour. | **Known** — RECON-02 A-6. **Extended by R5-07**: the endpoint **500s** on a case collision, which is both a crash and a signal. |
| `POST /auth/register/` | 400 `{"username": [...]}` vs 201. | **Known** — RECON-02 A-12. `email` has a `UniqueValidator` (`serializers.py:598-601`); `username` does not, so a concurrent duplicate hits the DB `unique=True` and raises `IntegrityError` → **500**, not 400. Untested. |
| `POST /clips/{id}/report/` | 201 + `report_id` vs 404, for **any** clip UUID, 20/hour. | **R5-14** — existence oracle + operator-queue pollution. |
| `POST /clips/{id}/play/` | 409 (no key) / 403 (licence) / 403 (bad token) / 200. The 403s are deliberately identical (`content.py:546-561`) and 409 precedes 403 **on purpose** (`:528-532`). | **OK** — best-designed oracle-resistance in the repo. |
| `POST /clips/{id}/share-link/` | 403 vs 403 vs 409 vs 201. Owner-scoped so it is a self-oracle. | **OK** |
| `GET /clips/{id}/public/` | 404 vs 200/HTML. `AllowAny`. | **OK** (no NC/SA filter — R5-01) |
| `GET /profile/{id}/` | 404 vs 200 for any `User` pk, **including `is_active=False` and `is_staff=True`**. Returns `username, profile_picture (storage key), profile_picture_url, followers_count, following_count, uploads_count, is_following, date_joined`. | **Accepted** — public profiles are a product feature. But there is **no `is_active` filter**, so a deactivated or staff account is still enumerable and its profile served. Worth a filter. |
| `POST /follow/{id}/toggle-follow/` | 404 vs 201/200. Confirms pk existence **and** that the account is followable. | **Low** — pk space is small integers, so this is a complete account-id enumeration at `user` 1000/hour. |
| `POST /legal/takedown/` | 404 `Clip not found` vs 201, **unauthenticated**, 30/hour. | **R5-06** — an unauthenticated existence oracle over the entire clip catalogue. |
| `POST /grievance/` | Always 201. | **OK** |
| `GET /legal/compliance/` | 200 always. | **OK** — IT Rules R4 requires it be reachable without an account. |
| `/metrics/` | 200 always, unauthenticated. | **R5-10** — includes `django_http_requests_total_by_status_total{status="429"}`, which is a **throttle-feedback oracle**: an attacker can measure exactly when to slow down. |
| `GET /api/v1/health/media-worker/` | 200/503, unauthenticated. | **R5-16** — internal worker liveness, and a hint that the deployment is the hybrid VPS+laptop topology. |
| Timing on `find_user` | `User.objects.get(username__iexact=…)` is an indexed lookup, then the self-check. No measurable timing oracle. | **OK** |

---

## 7. Rate limits & DoS

### 7.1 `throttle_scope` wiring audit (the `ScopedRateThrottle`-allows-everything trap)

`ScopedRateThrottle.allow_request` returns `True` — **no accounting at all** — when `getattr(view, 'throttle_scope', None)` is falsy (`rest_framework/throttling.py`). So every view below that declares no scope is silently unthrottled by that class. I verified each:

| View | Scope | Effective bound |
|---|---|---|
| `RegisterView` | `register` + `register_username` | 200/h IP + 3/h per username ✔ (both classes present, `auth.py:52`) |
| `ThrottledTokenObtainPairView` | `login` | 10/min IP ✔ |
| `ThrottledTokenRefreshView` | `token_refresh` | 120/h per **verified token subject** ✔ |
| `AudioUploadViewSet` | property → 8 method-name keys | ✔ verified: the map is keyed on `self.action` (method name), the Group C fix |
| `ClipInteractionViewSet` | property → `telemetry` / `interaction` | 60/min / 60/min ✔ |
| `ShareViewSet` | property → `share_send` / `share_poll` | 100/h / 1000/h ✔ |
| `CommentViewSet` | `comment` | 60/h ✔ |
| `PlaybackTokenView` | `playback_token` | 300/min ✔ |
| `DataSubjectAccess/ErasureView` | `data_subject` | 5/h ✔ |
| `ComplianceContactView`, `TakedownRequestView` | `legal` | 30/h ✔ |
| `GrievanceCreateView` | `grievance` | 10/h ✔ |
| `SubscriptionSyncView` | `subscription_sync` | 10/h ✔ |
| **`FastFeedViewSet`** | **none** | **`user` 1000/h only** — see 7.2 |
| **`SuggestionViewSet`** | **none** | `user` 1000/h — runs a pgvector HNSW query + composite rerank per call |
| **`TagsViewSet`** | **none** | `user` 1000/h — see R5-04 |
| **`ProfileViewSet`** (`me`, `me/update`, `retrieve`, `{id}/clips`) | **none** | `user` 1000/h — **`update_me` has no scope at all**, so username-squatting is bounded only at 1000/h |
| **`FollowViewSet`** | **none** | `user` 1000/h — a follow-graph inflation vector (see 7.4) |
| **`RevenueCatWebhookView`** | **none** | `anon` 100/h — fine, it is a no-op |
| **`LogoutView`** | **none** | `user` 1000/h |
| **`media_worker_health`** | **none** | `anon` 100/h — R5-16 |

### 7.2 `GET /feed/` is a Celery task amplifier

`feed.py:73-100`:

```python
redis_client = cache.client.get_client()
clip_ids_bytes = redis_client.lpop(redis_key, 10)
if not clip_ids_bytes:
    publish(refill_user_feed, user_id, count=40)
    clip_ids_bytes = redis_client.lpop(redis_key, 10)
```

`GET /feed/` is a **destructive `lpop`** (AGENTS.md documents this). An attacker who holds one free account can:

1. Register.
2. Call `POST /tags/initialize/` once (needs matching clips; or just never populate the queue).
3. Loop `GET /feed/` at up to 1000/hour. Each empty response publishes **one** `refill_user_feed` task with `count=40`.

That is **1000 task publications/hour from one account**, each of which rebuilds a 40-clip ranking (Redis ZSET ops plus, on the `sql` fallback path, a `CosineDistance` ORDER BY over `AudioClip`). `refill_user_feed` is routed to the `fast_feed` queue. 1000 accounts doing this is 1 M tasks/hour against a `fast_feed` worker pool. The `publish()` at `:78` is unconditional on an empty queue with **no debounce** — the queue is only refilled by the task, so the pathological loop is "call again before the worker runs", which is the cheapest possible request.

There is no per-user cooldown on the publish. `feed_pool.py:274-284` reads `zrevrangebyscore` on the user's pool, so a *warm* user is cheap — the amplifier is specifically the cold path, and the attacker controls whether they are cold.

**Not a fix I am proposing here** (it needs a Redis SETNX debounce on `feed:refill:requested:{user_id}` with a ~30 s TTL). Flagging it as the highest-effort-to-impact DoS in the app.

### 7.3 Unbounded growth — pruning audit

| Table / keyspace | Pruned? | Evidence |
|---|---|---|
| `token_blacklist_outstanding_token` | **NO** | `grep -rn "flushexpiredtokens"` over the whole repo: only doc hits, **no Beat entry, no cron, no management command**. `ROTATE_REFRESH_TOKENS=True` + `BLACKLIST_AFTER_ROTATION=True` (`settings.py:839-840`) ⇒ every refresh inserts an `OutstandingToken` and a `BlacklistedToken`, and `check_blacklist()` JOINs a table that only grows. **Known — RECON-02 A-9.** I confirm it independently and add: at 4 refreshes/h/user × 7-day retention ≈ **196 rows/user, unbounded in user count**, and it is the load-bearing control for "a stolen refresh token is single-use", so its silent degradation is worse than the row count. |
| `AuditLog` | **NO** | `middleware.py:48-59` writes one row per request, in a `finally`, with **no pruning task anywhere**. Combined with 7.5. |
| `Report`, `Grievance`, `TakedownRequest`, `DataSubjectRequest` | **NO** | No retention task. IT Rules R3(2) wants complaint records kept, so this is *correct* for those — but `Report.content` has no first-write cap (R5-19). |
| `Grievance` / `TakedownRequest` free text | **NO** | `TextField`, unauthenticated endpoint, no length validation. |
| `ConsentAudit` | **NO** and **must not be** — `models.py:90-95` and `services/erasure.py` deliberately retain it past account deletion. DPDP §5(2)/§11. **Correct.** |
| Redis `clip:<uuid>:<type>` and `clip:<uuid>:user:<id>:completion_*` | Drained every 300 s by `flush_counters_to_pg` — **but the keys themselves carry no TTL** | `counter_store.py` `increment` / `add_completion` are bare `INCRBY`/`INCRBYFLOAT`+`INCR`. If the flusher fails, they accumulate for ever. **R5-15.** |
| Redis `user_feed:{id}` | TTL 24 h (documented in `feed.py:82`) | OK |
| Redis `user_vectors:{id}` | TTL 900 s (`feed.py:32`) | OK |
| Redis `stream:interaction.events` | `maxlen ~50000, approximate=True` (`interactions.py:STREAM_MAXLEN`, used at `_xadd_telemetry`) | **OK** |
| Redis `telemetry:queue` (LIST fallback) | Drained every 30 s by `flush-telemetry-legacy` | OK, but the Beat entry carries a `TODO: remove after one cycle` (`settings.py:521`) and has been running since 2026-09. |
| Redis `processed_event:{event_id}` | `SETNX EX 86400` | OK |
| `hls/` orphan objects | `cleanup-orphan-hls` daily, bounded to 1000 keys/run | OK |
| DRF throttle buckets | `cache.set(..., timeout=window)` | **OK** — self-expiring, no pruning needed |
| `hls_auth.js` — n/a | | |

### 7.4 `POST /follow/{id}/toggle-follow/` — free, unscoped, unbounded graph write

`social.py:221-229` has **no `throttle_scope`**, so it runs at `user` 1000/hour. Each call is one `M2M.add()` or `remove()`. Consequences at 1000/hour:

- **Follow-graph inflation.** 1000 follows/hour/user. `PublicProfileSerializer.followers_count` is `Count('followers', distinct=True)` — a `JOIN` + `COUNT(DISTINCT)` over a table that grows at 1000 rows/hour/account, computed on **every** `GET /profile/{id}/` and every `GET /profile/me/`. This is a free amplification of the most expensive read in the profile path.
- **Ranking influence.** `_follows_author` is checked at `entitlements.py:115` and is one of the `ACCESS_*` reasons, so it does not gate playback — but the composite score's 45% vector term and the per-user pool are follower-aware.
- **No anti-abuse signal.** No "N follows from one IP in an hour" heuristic anywhere.

### 7.5 One DB INSERT per HTTP request, in a `finally`

`EchoFlow/middleware.py:44-61`:

```python
finally:
    try:
        from backend.app.models import AuditLog
        AuditLog.objects.create(
            user=...,
            action='view',  # Default; refined by endpoint would require view-level hook
            endpoint=request.path[:255],
            ip_address=request.client_ip,
            user_agent=request.META.get('HTTP_USER_AGENT', '')[:500],
            correlation_id=request_id,
        )
    except Exception:
        # SECURITY: Never break the request response for audit failure.
        pass
```

This runs on **every** request, including `/metrics/` (Prometheus scrapes every 15 s), `/health/`, every 404, every 401, and every static asset. There is no sampling and no exclusion list. At 1 000 rps that is 1 000 INSERTs/s of pure overhead, into a table with no pruning (7.3). It is also the mechanism for R5-05.

Two things I checked and am **not** reporting as defects:
- `AuditLog.user` **is** correct. `AuthenticationMiddleware` (position 10) runs *inside* `get_response`, so by the time the `finally` executes, `request.user` is populated. The `HACK` comment at `middleware.py:41-43` is accurate about the *log formatter* (`user_id` is `-` for lines emitted during the request) and explicitly says the DB row is correct. Both are right.
- `action='view'` for every endpoint is a real accuracy gap for a CERT-In artefact but is a data-quality issue, not a vulnerability.

### 7.6 Bounded mitigations worth recording

- `statement_timeout=30s`, `idle_in_transaction_session_timeout=60s`, `lock_timeout=10s`, `connect_timeout=10s` on the libpq `options` string (`settings.py:225`, gated on `ENGINE.endswith('postgresql')`). This is what bounds R5-04, R5-18 and the deep-offset cases. It is a real and effective control.
- `data_subject` 5/hour, `subscription_sync` 10/hour, `clip_approve` 20/hour (the HLS-encode trigger), `clip_report` 20/hour — all sensibly sized.
- `nginx` `client_max_body_size 100m` matches the serializer cap exactly.
- `refresh` is keyed on the verified token subject, not the IP (`throttling.py:81-99`), with the signature-verification rationale documented. Correct.

---

## 8. Replay / token lifetime

| Token | Format | TTL | Single-use? | Replay window | Verdict |
|---|---|---|---|---|---|
| **HLS media token** | `base64url(payload).base64url(HMAC-SHA256)`; payload `{u, c, exp, iat, v}` (`hls_token.py:158-190`) | `MEDIA_TOKEN_TTL_SECONDS`, default **600 s** | **No — reusable by design** | 600 s, per-clip scope | **Correct.** Non-single-use is *required*: an HLS stream is dozens of segment requests, and a single-use token would break playback on segment 2. The `c` prefix scope check (`hls_token.py:250-253`, `token.ts:130-132`) is what makes reuse safe. Bound by `exp` only — the docstring at `:170-176` says so explicitly. |
| **Share token** | Identical format, same secret, different TTL | `SHARE_TOKEN_TTL_SECONDS`, default **30 days** (`settings.py:725`) | **No** | 30 days, per-clip scope | **Accepted risk, correctly reasoned.** `content.py:412-420` documents it: a share token is a capability with `exp` as its only revocation. Both ends now refuse to mint for unmoderated or NC/SA content (`content.py:445-458` mint, `:506-541` exchange) — that mint-time refusal is the load-bearing control, because `validatePlaybackToken` cannot distinguish a share token from a media one. `POST /clips/{id}/play/` correctly re-mints a **600 s** token with `user_id=0` for the anonymous recipient (`content.py:566-568`), so the 30-day token never has to be attached to a player. |
| **Refresh token** | simplejwt, `jti` + `token_blacklist` | `REFRESH_TOKEN_LIFETIME` 7 days; `ROTATE_REFRESH_TOKENS=True` + `BLACKLIST_AFTER_ROTATION=True` (`settings.py:834-840`) | **Yes, effectively** — the presented token is blacklisted on use and `check_blacklist()` rejects reuse | Sliding: each refresh mints a fresh 7-day token, so a stolen token's *session* never expires (**RECON-02 A-5**). Rotation makes a stolen token single-use, so a race is a coin flip rather than a bypass. | **Known — RECON-02 A-5.** No absolute cap. |
| **Access token** | simplejwt | 15 min | n/a | 15 min after logout | **Accepted.** Logout cannot revoke a live access token; the docstring at `urls.py:64-66` states this deliberately. |
| **DataSubjectRequest.token_hash** | `models.py:386`, `max_length=128` | — | — | — | **Dead column.** Nothing writes it and nothing reads it. Not a live issue; a trap for whoever assumes a verification link exists. |
| **Takedown / Grievance** | none | n/a | n/a | n/a | No token, no verification, no counter-notice mechanism. `legal.py:60-63` acknowledges this as v1 scope. **R5-12.** |
| **Idempotency keys** | — | — | — | — | **None anywhere.** `POST /clips/` is not idempotent: a client retry after a timeout creates a second clip and a second 100 MB object. `services/uploads.py:16-18` names presigned PUT as the future fix. |
| **Celery `process_audio_to_hls`** | `autoretry_for=RETRYABLE_ERRORS, max_retries=3, retry_backoff=True, retry_backoff_max=600` (`tasks.py:169`) | — | **Idempotent enough** | — | The HLS output is written to a fresh `tempfile.mkdtemp` per attempt and uploaded to a deterministic `hls/{clip.id}` key. `file_overwrite=False` in `STORAGES` (`settings.py:630`) means a retry that reaches upload **fails** on the second attempt with a 412 — so a retry after a partial success marks the clip `failed` rather than duplicating. Worth knowing; not a vulnerability. |
| **`send_share`** | — | — | **NOT idempotent** | — | `services/shares.py:31` `ShareEvent.objects.create(...)` has **no** `unique_together` on `ShareEvent` (`models.py:237-245` — indexes only). 100/hour × retries = duplicate inbox rows. `record_share` is `get_or_create` (idempotent) but the inbox row is not. Low. |

**One genuine replay note:** the HLS token's `u` field is **never validated by any consumer**. `content.py:563-565` says so, and I confirmed it in all three validators: `hls_token.py` (Django), `token.ts:130-132` (Worker), `docker/nginx/hls_auth.js` (a stub, so N/A). So a token minted for user 1 is fully usable by user 2 if it leaks. This is **by design** and correct for the anonymous share flow (`u=0`), but it means token *binding* to a user does not exist — the token is a bearer credential scoped only to a clip and a time window. Consistent with the docs; recording it so nobody later writes a false claim that the token is user-bound.

---

## 9. Secrets exposure

### 9.1 Browser bundle — clean

- **No `.env*` file exists in `frontend/`** at all (`ls -la frontend/.env*` → no such file). `SECURITY.md` explicitly puts `frontend/` out of scope as a demonstration directory.
- `grep -rn "VITE_|import.meta.env" frontend/` → **exactly one hit**: `src/api/client.ts:20`, `import.meta.env.VITE_API_BASE_URL || "http://localhost:18000"`.
- `vite.config.ts` injects **no** `define` block, no `envPrefix` widening, no build-time secret substitution. It only sets `@` → repo root, the React plugin, Tailwind, and an AI-Studio `DISABLE_HMR` switch.
- `git ls-files frontend` — 36 files, all source/config. No `.env`, no keystore, no token.
- **`grep -rniE "secret|api[_-]?key|sk_live|pk_live|hf_[A-Za-z]{10}|AKIA|whsec|-----BEGIN" frontend/src frontend/index.html frontend/metadata.json`** → only `Login.tsx` / `client.ts` / `auth.tsx` matches on the *word* `password` in ordinary credential-handling code. Zero actual values.
- **Built bundle** `frontend/dist/assets/index-CWwvDKWH.js` (928 KB), scanned for `sk_live|pk_live|hf_…|AKIA…|change-me…|minio:9000|localhost:9000|redis_broker|echoflow_db|DB_PASSWORD=|MEDIA_TOKEN_SECRET=|DJANGO_SECRET_KEY=` → **0 hits**. `frontend/dist/` is gitignored (`.gitignore:120`) and `.dockerignore` excludes `frontend` entirely.
- Token storage: `sessionStorage` only (`client.ts:16, 28-42`). No `localStorage`, no cookie, no IndexedDB. No `console.log` of a token — the only `console.` calls in `client.ts` are `console.warn("Server logout notification failed:", err)` at `:245`, which passes an `Error`, not a token. **R2 covered this; I confirm no regression.**

**One real (non-secret) issue:** `client.ts:20` hardcodes a **fallback** API origin. If `VITE_API_BASE_URL` is unset at build time, the production bundle silently points at `http://localhost:18000` — mixed-content-blocked on `https://app.echoflow.in`, so the app is dead rather than insecure. Worth making the build fail instead, but it is a correctness bug, not a disclosure.

### 9.2 Backend / repo

- `git ls-files | grep -E "\.env"` → **only** `.env.example`, `.env.laptop.example`, `.env.vps.example`, `mobile/.env.example`. The real `.env`, `.env.local`, `.env.laptop` are all ignored (`.gitignore:1-2, 40-45`) and **absent from the index**.
- `ci` runs `scripts/check_no_tracked_env.sh` on every PR, per AGENTS.md.
- `.dockerignore` excludes `.env`; the `Dockerfile` uses an explicit allowlist (`COPY backend/`, `manage.py wait_for_db.py gunicorn.conf.py`, `COPY ai_ml/`) — never `COPY . .` — so no env file can reach an image even if one appeared in the build context.
- `settings.py:713` `MEDIA_TOKEN_SECRET` is guarded by `is_placeholder_secret()` (`hls_token.py:60-91`) — empty, whitespace-only, an exact documented placeholder, any of 11 placeholder substrings, or any `<`/`>` template marker. **R2 covered this; confirmed unchanged and I found no bypass.** Note the substring list includes `"example"` and `"todo"`, which will false-positive on a legitimately-generated secret containing those words — the docstring calls this "the safe direction", which is right.
- `settings.py:19-23` fails fast on an **empty** `DJANGO_SECRET_KEY` but not on a short or placeholder one. **R2 covered the length half (RECON-02 A-11); the placeholder half is still open** and is the same defect class `c897426` fixed for `MEDIA_TOKEN_SECRET`. `.env.example` and `.env.vps.example` still ship `change-me-…` (33 bytes, passes a length check, fails the value check).
- `REVENUECAT_SECRET_KEY` (`settings.py:945`), `AWS_SECRET_ACCESS_KEY` (`settings.py:623`), `REDIS_*_PASSWORD` — read from env only, never logged. `services/revenuecat.py:26-30` puts the secret in an `Authorization: Bearer` header to a hardcoded host. `logger.warning("RevenueCat API error for %s: %s", ...)` at `:45` passes the **exception**, and `requests` does not put request headers in `HTTPError` reprs. Clean.
- **`backend/scripts/seed_clips.py:83-84`** — `DEFAULT_USERNAME = "seeduser"`, `DEFAULT_PASSWORD = "SeedLocal!2026"`, committed, with a 6-line comment explaining it is a deliberate local-only throwaway. And **`:73` `DEFAULT_MEDIA_DIR = "/mnt/dev-drive/my songs"`** — the owner's local filesystem path and a hint at their name, in a public repo. **R5-22.** Neither is a live credential in a deployed environment, but the password will be picked up by every secret scanner forever and `seeduser` may still exist in a local Postgres.
- `docker/certs/localhost.{crt,key}` — a **private key committed to the repo on purpose** (AGENTS.md says so, and documents the revocation-only remedy). Self-signed, dev-only, and nginx is `server_name _`, so it is a MITM vector only against a developer who trusts it. Consistent with the documented decision; not a finding, but it is the one place where "in the repo on purpose" is doing real work.
- Sentry: `send_default_pii=False` per AGENTS.md; `services/sentry.py:34` attaches only `correlation_id` as a tag and `op`/`clip_id` as extras. `clip_id` is a `uuid4`, not PII. **I did not find a Sentry misconfiguration**; the one caveat is that `capture_exception` calls in `services/interactions.py` pass `clip_id` but **never** `user_id`, so there is no user correlation in Sentry either.

---

## 10. Grep evidence for every "checked and clear" claim

| Claim | Command / scope | Result |
|---|---|---|
| No `shell=True` | `grep -rn "shell=True" --include=*.py backend ai_ml` minus tests | **0** |
| No `os.system` / `os.popen` | `grep -rnE "os\.system\|os\.popen" --include=*.py backend ai_ml` | **0** |
| No Python `eval(` | `grep -rnE "(^\|[^a-zA-Z_.])eval\(" --include=*.py backend ai_ml` | **0** |
| No `yaml.load` / `pickle.loads` / `marshal.loads` | `grep -rnE "yaml\.load\|pickle\.loads\|marshal\.loads" --include=*.py backend` | **0** |
| No Django file-serving route | `grep -rnE "static\.serve\|FileResponse\|sendfile\|X-Accel" --include=*.py backend` | **1**, and it is the comment at `app/urls.py:103` explaining the route's absence |
| No `mark_safe` / `\|safe` | `grep -rnE "mark_safe\|\|safe" --include=*.py --include=*.html backend` | **0** |
| No `format_html` / template rendering of user data | `grep -rn "format_html\|Template(" --include=*.py backend` | **0** |
| No `verify=False` / disabled TLS verification | `grep -rnE "verify=False\|ssl_verify\|CURLOPT_SSL_VERIFYPEER" --include=*.py --include=*.sh --include=*.ts backend scripts workers` | **0** (`seed_clips.py` uses `--verify <ca-bundle>` and `verify=False` only from an explicit `--verify false` flag) |
| No raw SQL with user input | `grep -rn "\.raw(\|RawSQL\|cursor()\|cursor\.execute\|extra(" --include=*.py backend ai_ml` | 3 production hits, all analysed in §3.1; `cursor.execute(f"EXPLAIN …")` is in `test_integration_pgvector.py:121` (test-only) |
| No XSS sink in the frontend | 12-pattern sweep over `frontend/src/` — see the table in §5.1 | **0** for every markup/exec sink; 5 benign dynamic-URL/navigation hits individually cleared |
| No CSP anywhere | `grep -rn "Content-Security-Policy\|contentSecurityPolicy\|helmet\|CSP_" --include=*.py --include=*.conf --include=*.ts --include=*.tsx --include=*.json --include=*.html --include=*.yml backend docker frontend workers` | **0** — confirms the absence (R5-24), and `grep -n "add_header"` on both nginx configs shows only HSTS / nosniff / XFO / Referrer-Policy |
| No secret in the browser bundle | `grep -rniE "secret\|api[_-]?key\|sk_live\|pk_live\|hf_[A-Za-z]{10}\|AKIA\|whsec\|-----BEGIN" frontend/src frontend/index.html frontend/metadata.json` | Only the word `password` in credential-handling code; **0** secret values |
| No secret in the built bundle | 14-pattern scan of `frontend/dist/assets/*.js` for live-secret shapes **and** internal hostnames (`minio:9000`, `redis_broker`, `echoflow_db`, `*_PASSWORD=`, `*_SECRET=`) | **0** |
| No `frontend/.env` | `ls -la frontend/.env*` | No such file |
| No env file in git | `git ls-files \| grep -E "\.env"` | 4 `.example` files only |
| No `page_size` override | `grep -n "page_size_query_param\|max_page_size" .venv/…/rest_framework/pagination.py` (DRF **3.18.0**) | `page_size_query_param = None` on both `PageNumberPagination:175` and `CursorPagination:533` |
| No `flushexpiredtokens` | `grep -rn "flushexpiredtokens\|OutstandingToken\|token_blacklist"` repo-wide | Only doc hits; **no** Beat entry, cron, or command |
| No license-helper / scraper gap | `grep -rn "def normalize_license\|def license_features\|def license_allows_commercial\|def is_noncommercial_license\|def resolve_podcast_rss" ai_ml/`; `git ls-files ai_ml/scrapers \| wc -l` | All five defined (`base.py:210,257,273,317,352`); 12 files tracked; `state.py` and `log.py` present. **AGENTS.md's "Open" item is stale** (§15) |
| No `is_placeholder_secret` bypass | `hls_token.py:60-91` read in full; callers `views/media.py` (via `generate_playback_token`) and `services/hls_token.py` | `RuntimeError` on empty / whitespace / exact placeholder / 11 substrings / any `<` `>` |
| Throttle scope presence | Read `throttling.py` in full + every `views/*.py` `throttle_scope` / `get_throttles` | 12 views scoped, 7 unscoped — all 7 listed in §7.1 |
| `select_related`/`prefetch_related` on unbounded sets | `prefetch_related` in `social.py:52-66, 87, 202` | All three are `Prefetch` on `ShareEvent` (a share inbox) and `.inbox`; `_annotated_clip_prefetch` uses `.select_related('creator')` + `Exists` annotations, not a row-amplifying join. No unbounded prefetch. `inbox` (`social.py:196-206`) is the one **unpaginated** list endpoint and is bounded only by the receiver's own share count. |

---

## 11. Abuse cases

### A-1 — Read another user's NC/SA catalogue through their profile page
- **Preconditions:** one free account. Target must have uploaded at least one `is_noncommercial=True` or `requires_share_alike=True` clip that reached `status='ready'` (the scraper path, `SCRAPER_ALLOW_NC=True`).
- **Request:** `GET /profile/{target_id}/clips/` with a valid access token.
- **Impact:** full `FeedClipSerializer` row for every licence-restricted clip — `title, creator_name, category, hls_playlist_url, likes, shares, skips, comment_count, tags, duration_ms, cover_image`. Content that `feed.py:115`, `feed.py:137`, `feed.py:186`, `social.py:173` and `content.py:450`/`content.py:533` all deliberately withhold is enumerated. Audio stays protected (the edge needs a token and `resolve_clip_access` denies), so this is a licensing/catalogue disclosure, not a playback bypass.
- **Test that catches it:** create `is_noncommercial=True, status='ready', moderation_approved=True` and `moderation_approved=False, status='ready'` clips; `GET /profile/{owner}/clips/`; assert `len(r.data['results']) == 0`. Both halves must be separate assertions — a single assertion passing for the wrong reason is exactly the failure mode in the frontend-rebuild learnings.

### A-2 — Write to another user's clip, and poison its ranking
- **Preconditions:** one free account. Target clip UUID (leaked via A-1's `id`, or any app response).
- **Request:** `POST /interactions/{victim_clip_id}/register-skip/` `{"listen_duration_ms": 30000, "reel_position_ms": 1, "reel_id": "00000000-0000-0000-0000-000000000000"}` ×60, then `POST /interactions/{victim_clip_id}/log-telemetry/` `{"action_type": "view", "watch_time_ms": 30000}` ×60.
- **Impact:** `completion_rate = 1.0` samples and `skips`/`engagement_velocity` deltas applied to a clip the caller has no entitlement to — including a `moderation_approved=False` clip that appears in no feed. `flush_counters_to_pg` writes them to `avg_completion_rate` (30% of the composite) and `engagement_velocity` (25%), so when the clip *is* approved it is already ranked as if 100% of users finished it.
- **Test:** as above; assert 404 **and** assert `UserInteraction.objects.filter(user=user, clip=clip_b).exists() is False` **and** that no Redis key `clip:{id}:*` was created.

### A-3 — Force `avg_completion_rate` to exactly 1.0 on any clip
- **Preconditions:** one free account, plus the target's `duration_ms` (exposed by `FeedClipSerializer`).
- **Request:** `POST /interactions/{clip_id}/log-telemetry/` `{"action_type":"view","watch_time_ms": <duration_ms>}` ×60/min.
- **Impact:** `services/interactions.py:282-283` computes `completion_rate = min(watch_time_ms / max(duration_ms,1), 1.0)`. Sending `watch_time_ms == duration_ms` yields **exactly 1.0 with no manipulation arithmetic at all** — the same shape as the `listen==position` bug commit `20f6e7e` fixed in `record_skip`, left in place in `record_telemetry`. 30% of the composite score, at 60 samples/minute, is a total capture of that term.
- **Test:** seed a clip with `duration_ms=30000, avg_completion_rate=0.5`; POST `watch_time_ms=30000`; drain `counter_store` and call `_apply_completion_deltas`; assert the result is **not** ≈1.0. Or, more robustly and without reaching into Redis: assert `record_telemetry` never writes a `completion_rate` derived solely from a client integer — e.g. that it uses the same server-side divisor as `record_skip` (`_completion_rate`), or that `watch_time_ms` is rejected when it is not backed by an issued playback token. **This is the one I would fix first among the ranking items**, because the fix already exists in the codebase and was simply not applied to the sibling function.

### A-4 — 50 000-term SQL from one POST
- **Preconditions:** one free account.
- **Request A (crash):** `POST /tags/initialize/` `{"selected_tags": 5}` → `for tag in 5` raises `TypeError: 'int' object is not iterable` at `feed.py:265` → **500**.
- **Request B (stall):** `{"selected_tags": ["t0","t1", …, "t49999"]}` → `feed.py:264-266` builds `Q(tags__contains=[tag])` OR'd 50 000 times. One statement, one parameter set, `AudioClip.tags` is a `JSONField` with **no GIN index** (the `AudioClip.Meta.indexes` at `models.py:175-203` has nothing on `tags`) ⇒ 50 000 sequential scans. Killed by `statement_timeout=30s` (`settings.py:225`) — but repeatable at `user` 1000/hour with no scope on the view, and the 30 s of CPU+buffer churn lands on the same Postgres serving every request.
- **Request C (type):** `{"selected_tags": [{"a": 1}]}` → `tags__contains=[{"a":1}]` against JSONB → `DataError` → 500.
- **Test:** three assertions — non-list `selected_tags` → 400; a 10 000-element list → 400 (or 200 with a bounded tag set); a 1-element list of a non-string → 400. A `ListField(child=CharField(max_length=50), max_length=20)` serializer in front of the view fixes all three at once.

### A-5 — Suppress the audit record for any request
- **Preconditions:** none. Unauthenticated.
- **Request:** any request with `X-Request-ID: ` followed by 65+ characters.
- **Impact:** `middleware.py:31` `request_id = request.META.get(self.HEADER)` is stored **untruncated**; `AuditLog.correlation_id` is `varchar(64)` (`models.py:366`). Postgres raises `StringDataRightTruncation`; the `try/except Exception: pass` at `middleware.py:59-62` swallows it. **No `AuditLog` row is written for that request.** The attacker chooses per-request, so they can suppress exactly the requests they make — and DPDP §5(1) notice evidence plus CERT-In 2022 180-day identity retention are both served out of this table. The asymmetry is the bug: `user_agent` is truncated `[:500]` at `:57` and `endpoint` `[:255]` at `:56`; `correlation_id` is the only unbounded one.
- **Test:** `client.get('/legal/compliance/', headers={'X-Request-ID': 'A'*200}, secure=True)`; assert 200 **and** `AuditLog.objects.filter(ip_address=...)` count increased by 1. Run it over an endpoint that does not require auth so no other variable is in play.

### A-6 — Unauthenticated 500s on the regulatory endpoints
- **Preconditions:** none. Unauthenticated, 30/hour and 10/hour per IP.
- **Requests:** `POST /legal/takedown/` `{"clip_id":"x","reason":"y","requester_email":"a@b.c"}` → `ValidationError: 'x' is not a valid UUID` at `legal.py:75`, uncaught → **500**. `POST /legal/takedown/` `{"clip_id":"<valid>","reason":"y","requester_email":"A"*300}` → `varchar(254)` → **500**. `POST /grievance/` `{"subject":"A"*201,"description":"y"}` → `varchar(200)` → **500**. `POST /grievance/` `{"subject":"ok","description":"y","user_email":"A"*300}` → **500**.
- **Impact:** a remote, unauthenticated, per-IP-rate-limited 500. A distributed attacker gets one per request from every IP. Each also produces a Sentry event, so the noise is real, and `legal.py:75`'s 404-vs-500 split is a **clip-existence oracle for the whole catalogue** (404 for a valid-but-absent UUID, 500 for a malformed one, 201 for a real one).
- **Test:** four parametrized cases, each asserting a 4xx (400 for a bad UUID, 400 for an over-length `varchar`, 422 for a bad email) and asserting `status_code != 500`. Note `legal.py` bypasses every serializer — the fix is a `serializers.Serializer`, not a `len()` check.

### A-7 — Crash and squat the user directory with a case-collision
- **Preconditions:** register `Alice` and `alice` (both are legal: `AbstractUser.username` is `unique=True`, which is **case-sensitive**; `UnicodeUsernameValidator` allows both, and `RegisterSerializer` has no `UniqueValidator` on username).
- **Request:** `GET /share/find-user/?username=alice` with any free account.
- **Impact:** `social.py:120` `User.objects.get(username__iexact=username)` matches **two** rows → `MultipleObjectsReturned`; the `except User.DoesNotExist` at `:124` does not catch it → **500**. And the squat is durable: as long as *any* case variant of a name exists, `find_user` 500s for that name, so the legitimate user cannot be found by anyone.
- **Test:** register `Bob` and `bob`; assert `GET /share/find-user/?username=BOB` returns **200**, not 500. The fix is `.filter(username__iexact=…).first()` (or `.values(...)[:2]` and reject ambiguity), and the same case-sensitivity gap exists in `ProfileUpdateSerializer.validate_username` (`serializers.py:868-872`, exact `filter(username=value)`), so `PATCH /profile/me/update/ {"username": "bOB"}` can claim a name that is visually identical to someone else's.

### A-8 — Post-moderation content swap
- **Preconditions:** one free account. Self-approval is allowed (`content.py:272-279`, documented as the v1 workflow).
- **Request:** `POST /clips/` (any audio) → `POST /clips/{id}/approve-moderation/` → 200 `{"status":"approved"}` → wait for `status='ready'` → `PATCH /clips/{id}/` `{"title": "<obscene text>", "category": "anything"}` (also `{"license_type": "CC-BY-NC", "copyright_owner_name": "someone else"}`).
- **Impact:** the clip is live in `/feed/` and `/suggestions/` with a title and category that **never passed `run_moderation_check`**. `AudioUploadViewSet.update` (`content.py:226-241`) strips only `original_file`. There is no re-moderation trigger and no immutability after approval. Note the divergence the fix must not create: `license_type` is the *displayed* licence and is user-writable, while `is_noncommercial` is the *enforced* column and is not in `Meta.fields` (`serializers.py:236`) — so today a user can relabel a commercial clip `CC-BY-NC` with no effect on the feed gate, which is confusing but fail-safe.
- **Test:** create → approve → `PATCH {"title": "x"}`; assert either 400 ("title is immutable after approval") or `clip.moderation_approved is False` and the clip is out of every feed query.

### A-9 — Freeze the cache Redis with `KEYS`
- **Preconditions:** enough `(clip, user)` completion samples that `clip:*` grows large; or simply a period during which `flush_counters_to_pg` fails.
- **Trigger:** the 300 s Beat entry `'flush-counters-to-pg'`, which calls `counter_store.drain()` → `counter_store.py:100` `local keys = redis.call('KEYS', KEYS[1])` with `KEYS[1] = 'clip:*'`, then one `GET` and one `DEL` per key, all inside **one Lua script**.
- **Impact:** `KEYS` is O(N) and **blocks the single-threaded Redis server** for its duration, and the whole drain is one atomic script that cannot be interleaved. The keyspace is not small: `clip:<uuid>:likes|shares|skips` plus **`clip:<uuid>:user:<id>:completion_sum|count`**, i.e. it scales as clips × users. That Redis also holds **every DRF throttle bucket** (all of §7.1), `user_vectors:{id}` (15 min cache) and `user_feed:{id}` (24 h queues). A multi-second block means throttles stop counting — an attacker gets free rate-limit headroom — and `/feed/` lpop stalls. The returned flat list is also 2× the key count in one reply, so a large keyspace risks the Lua reply blowing the client buffer.
- **Fix shape:** `SCAN` in a loop of bounded batches (`MATCH clip:* COUNT 500`) plus a `MULTI`/Lua-`GETSET` per batch. The repo already has the right pattern in `services/erasure.py:76-80` (`COMPLETION_KEY_PATTERN` + `_SCAN_BATCH = 500`) — the author knew; it just was not used here.
- **Test:** seed N=50 000 `clip:*` keys, call `drain()`, assert the implementation issues `SCAN` (monkeypatch/spy on the client's `scan` and assert `keys` is never called). A behavioural assertion ("drain returns all of them") passes on both implementations and is worthless here.

### A-10 — Delete the evidence against yourself
- **Preconditions:** one free account; one complaint filed against your clip.
- **Request:** `POST /legal/takedown/` (or `/clips/{id}/report/`) → `DELETE /clips/{id}/` (owner-scoped, `ModelViewSet.destroy`).
- **Impact:** `TakedownRequest.clip` and `Report.clip` are both `on_delete=models.CASCADE` (`models.py:397`, `models.py:417-423`). Deleting the clip **destinguishes the complaint record**, including `requester_email` / `user` / `report_reason` / `status`. IT Rules 2021 R3(1)(b)/(2) requires categorised complaint handling and an acknowledgment trail; a respondent who can erase the complaint has defeated it. Contrast `ConsentAudit`/`AuditLog`/`Grievance`, which were deliberately moved to `SET_NULL` for exactly this reason (`models.py:90-95`) — the pattern exists in the repo and was simply not applied to `Report`/`TakedownRequest`.
- **Test:** file a takedown, delete the clip, assert the `TakedownRequest` row still exists with `clip_id` nulled (or a retained snapshot).

### A-11 — Fabricate a grievance against a named person
- **Preconditions:** none. Unauthenticated, 10/hour/IP.
- **Request:** `POST /grievance/` `{"subject": "…", "description": "…", "user_email": "victim@example.com"}`.
- **Impact:** `grievance.py:31` `user_email=data.get('user_email') or (user.email if user else None)` accepts **any** email string with no verification, and `acknowledgment_due` is stamped to now+24 h (`grievance.py:23-25`), which the IT Rules R3(2) SLA makes an operational obligation. A flood of fabricated grievances bearing a third party's address turns the regulator-facing channel into a harassment vector against a named person and consumes the operator's 24 h acknowledgment budget.
- **Same shape:** `POST /legal/takedown/` with an arbitrary `requester_email` — a **weaponised DMCA-style takedown**: claim to be a copyright holder, get an operator to action 30/hour of takedown requests against a competitor, with no counter-notice mechanism (`legal.py:60-63` acknowledges its absence).
- **Test:** assert that an anonymous grievance's `user_email` is either rejected or recorded as `null` with the submitter's IP retained instead; and that `requester_email` on a takedown is validated as an email **and** does not by itself create an operator obligation. Minimum viable fix: keep the address, add a verification/acknowledgment state, and cap per-address submissions.

### A-12 — Free follow-graph inflation
- **Preconditions:** one free account.
- **Request:** `POST /follow/{n}/toggle-follow/` for n = 1…1000, alternating follow/unfollow to stay under nothing in particular. `social.py:221` declares **no `throttle_scope`**, so the only bound is `user` 1000/hour.
- **Impact:** 1000 M2M rows/hour. `PublicProfileSerializer.followers_count` is `Count('followers', distinct=True)` (`profile.py:47-51`) — a join-and-distinct-count over a growing table, recomputed on **every** `GET /profile/{id}/` and every `GET /profile/me/`. There is no follow cap, no follow-rate signal, and no anomaly detection.
- **Test:** assert a dedicated `follow` scope exists in `DEFAULT_THROTTLE_RATES` and that the view declares it (the same "does the scope exist" assertion as `TestRefreshThrottleWiring`, which R2 established as the right shape).

### A-13 — Deep-offset pagination burn
- **Preconditions:** one free account with >1 clip.
- **Request:** `GET /clips/?page=999999`.
- **Impact:** `PAGE_SIZE=20` ⇒ `OFFSET 19 999 780`, a full index scan-and-discard, bounded only by `statement_timeout=30s`. Repeatable at 1000/hour on `GET /clips/`, `GET /share/`, `GET /suggestions/`.
- **Important negative result:** `?page_size=` is **not** honoured — `page_size_query_param = None` on both paginator classes in DRF 3.18. So the common "unbounded page_size" finding does **not** apply here; only `?page=` does.
- **Test:** assert `GET /clips/?page_size=10000` returns at most `PAGE_SIZE` rows (pins the negative result so a future `page_size_query_param = 'page_size'` cannot land unnoticed), and assert a `MAX_PAGE` cap on `?page=`.

### A-14 — Webhook landmine
- **Preconditions:** none. Unauthenticated, no throttle scope.
- **Request today:** `POST /webhooks/revenuecat/` with any body → `subscription.py:136` `if getattr(settings, "REVENUECAT_WEBHOOK_SECRET", "") and signature:` is **False** when the secret is unset, so verification is skipped entirely and the response is `200 {"status":"received"}`. No state changes, so the impact today is nil.
- **Why it is still worth writing down:** (a) the shape is **fail-open** — the safe behaviour is to 503 when a secret is expected and absent; (b) the docstring at `:120-126` says Phase 2 will "return 401 on signature mismatch", and whoever implements that will be editing a branch that currently returns 200 on *everything*; (c) the code computes `hmac.new(secret, request.body, sha256).hexdigest()` and compares it to the `X-RevenueCat-Signature` **header**, while the docstring at `:116-118` says the signature *is* that header. Those are not the same scheme — RevenueCat's signature is over a payload envelope, not a raw-body HMAC — so with a secret actually configured, **every genuine RevenueCat webhook will be rejected 401**. That will present as "webhooks silently never work" and cost more to diagnose than to fix now.
- **Test:** with the secret unset, assert the endpoint does **not** return 200 (503 is the right answer). With the secret set, assert a request signed per the documented RevenueCat scheme is accepted — which means the current implementation will fail this test, and that is the point.

---

## 12. What a fix MUST preserve

1. **The A4 licence gate ordering.** `resolve_clip_access` (`entitlements.py:102-121`) must keep checking `moderation_approved` → owner → shared → **`is_license_restricted` before** `_follows_author`/`_has_interaction`. Any "tighten the entitlement check" change must not move the licence test below the interaction test, or forging a `UserInteraction` row (A-2) becomes a playback bypass for NC/SA content.
2. **`upload_shared` / mint-time refusal.** `content.py:445-458` and `:506-541` must both keep refusing NC/SA and unmoderated clips. `validatePlaybackToken` cannot distinguish a share token from a media token, so mint-time refusal is the *only* load-bearing control (already reasoned at `content.py:429-444`).
3. **The 409-before-403 order in `play_shared`.** `content.py:528-532` deliberately checks the media key before the licence so a mid-encode clip reports "retry", not "forbidden". Swapping them changes a retryable 409 into a permanent-looking 403.
4. **The 30-day share token must stay distinguishable-in-intent-only.** It is a media token with a longer TTL. Do not add a second secret or a second payload version — three validators (Django, Worker, nginx njs) must agree byte-for-byte (`hls_token.py:16-19`).
5. **`ScopedRateThrottle` scope names must stay method names, not `url_path`.** `content.py:148-160` and `:169-175` and `social.py:104-112` and `interactions.py:91-97`. The Group C bug was that they were `url_path`. Any new per-action scope must be keyed the same way, and `test_throttling.py`-style "scope exists on the view" assertions are the only thing that catches a repeat.
6. **`is_placeholder_secret` must stay a *substring* test.** An exact-match allow-list is what let `change-me-to-a-long-random-string` become a production HMAC key. Do not tighten it to a set, and do not add an exception for values that "look random".
7. **DRF's `get_object_or_404` catches `(TypeError, ValueError, ValidationError)`.** Every replacement for `AudioClip.objects.get(...)` must keep that, or a malformed UUID turns a 404 into a 500. A-6 is exactly this.
8. **`statement_timeout=30s` + the libpq `options` string** must stay gated on `ENGINE.endswith('postgresql')` (`settings.py:225`) — it is what makes A-4/A-13 survivable.
9. **The escape() discipline in `_render_share_card`.** Any new field added to that HTML page must go through `django.utils.html.escape`. It is the only rendered-HTML surface in the codebase, and it is unauthenticated.
10. **The Worker's `startsWith("/hls/")` check must run on `new URL(request.url).pathname`, not a raw string slice.** The URL parser's dot-segment removal is what makes path traversal a non-issue. Any refactor that switches to `request.url.substring()` re-opens A-N for object-key traversal.
11. **The seeded-suite baseline: 716 pass / 0 fail / 7 skipped; frontend 48 pass.** `test_metrics_endpoint.py:60` currently *asserts* `/metrics/` returns 200 unauthenticated, so R5-10's fix will need that test changed deliberately, with the change called out in the commit — not silently.
12. **Do not "fix" R5-01 by adding a `status='ready'`-only check.** Both filters are needed, and `moderation_approved` is the one that survives a worker retry flipping the flag back to `False` after `status` is already `'ready'`.

---

## 13. Recommended fix order

**Tier 1 — untrusted input reaching the DB and the audit trail (one-line-to-ten-line changes, all with a clear failing test):**

1. **A-5** — truncate `request_id` in `middleware.py:31` (`request_id[:64]`), matching `user_agent`/`endpoint`. One line. Highest value per line in this report: it removes an attacker-controlled switch over whether a DPDP/CERT-In record exists.
2. **A-6** — replace `AudioClip.objects.get(id=clip_id)` in `legal.py:75` with `get_object_or_404`; add a `serializers.Serializer` to `TakedownRequestView` and `GrievanceCreateView` (or at minimum `max_length` clamps + email validation) instead of raw `request.data.get`. Four tests.
3. **A-7** — `.filter(username__iexact=…).first()` in `social.py:120`, and the same case-insensitive uniqueness check in `ProfileUpdateSerializer.validate_username`. One test.
4. **A-4** — a `ListField(child=CharField(max_length=50), max_length=20)` serializer in front of `TagsViewSet.initialize_vectors`, plus a `throttle_scope`. Kills the crash, the type confusion, the tag bomb, and the recommendation-steering vector in one object.
5. **A-2** — scope `ClipInteractionViewSet.get_queryset()` the way `approve_moderation` already is (`content.py:277-279`). One method; removes a write-IDOR and the ranking-poisoning surface.

**Tier 2 — authorization and licensing consistency:**

6. **A-1** — add `moderation_approved=True` and `is_noncommercial=False, requires_share_alike=False` to `profile.py:67`. Copy the predicate from `feed.py:111-115` verbatim so the two cannot drift — `social.py:147-151` already documents why "the same filter the feed uses" is the rule.
7. **A-8** — decide the policy (I recommend: `title`/`category`/`license_type` become immutable once `moderation_approved=True`, with an explicit "edit → re-moderate" transition that sets the flag back to `False`), then implement it in `AudioUploadViewSet.update`.
8. **A-11** — require verification for `requester_email` / `user_email` on the two regulatory endpoints, or at minimum stop treating an unverified address as creating an operator obligation. Add a per-address submission cap. This one is a **product/ops decision**, not purely a code fix — see §16.
9. **A-10** — move `Report.clip` and `TakedownRequest.clip` to `on_delete=SET_NULL` + nullable, mirroring the pattern already applied to `ConsentAudit`/`AuditLog`/`Grievance`. Requires a migration.
10. **A-3** — apply the existing `_completion_rate(listen_duration_ms, clip)` server-side divisor to `record_telemetry` as well. Smallest-delta fix in Tier 2 and it closes 30% of the composite score to client control.
11. **A-14** — add a `follow` throttle scope, and add a per-user follow-rate sanity cap.

**Tier 3 — availability and disclosure:**

12. **A-9** — replace `KEYS` with a batched `SCAN` in `counter_store.drain()`, copying `erasure.py`'s `_SCAN_BATCH` pattern. Add TTLs to the counter keys as a backstop.
13. **A-7 (metrics)** — put `/metrics/` behind auth or an nginx `allow`/`deny` on the scrape source, and update `test_metrics_endpoint.py:60` deliberately.
14. **`GET /feed/` publish debounce** — a Redis `SETNX feed:refill:requested:{user_id}` with a ~30 s TTL, so an empty queue cannot republish 1000×/hour.
15. **A-5 (storage)** — one INSERT per request in a `finally` with no pruning. Needs an exclusion list (`/metrics/`, `/health/`, `/ready/`) and a retention task. This one is an architecture conversation, not a patch.
16. **A-13** — a `MAX_PAGE` clamp.
17. **A-11/R5-24** — a CSP (`script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`) via `_headers` for Pages and an `add_header` for the API origin. Note `frame-ancestors 'none'` in the CSP would let the `X-Frame-Options: DENY` at `nginx.conf:110` be retired.

**Explicitly last:** R5-20 (delete the stub and correct the comments — a docs/ops task, not a security task), R5-21, R5-22, R5-16, R5-17, R5-18, R5-19, and the `flushexpiredtokens` Beat task (RECON-02 A-9).

---

## 14. Deliberately NOT fixed for MVP — with reasoning

| Item | Why not now |
|---|---|
| **A-1's audio exposure** | There isn't any. `resolve_clip_access` still gates the token and the edge still gates the bytes. This is a metadata/catalogue disclosure, and the feed-consistency argument (two different definitions of "what is servable") is a stronger reason to fix it than the disclosure is a risk. Fix it in Tier 2 for consistency, not urgency. |
| **A-3's deeper problem** | Even with the server-side divisor, `watch_time_ms` remains client-asserted, because the only true measure of watch time lives in the player. Commit `20f6e7e` says this explicitly. The real fix is cryptographic — issue a playback token, and only accept telemetry for a clip whose token was actually issued inside the TTL. That is a schema/protocol change. Do the cheap half now (server-side divisor), file the rest. |
| **R5-08's "real moderation"** | The content decision is ISSUE-04 and is explicitly not a code fix. `run_moderation_check`'s three checks are all inert at `approve-moderation` time (transcript is not persisted, tags default `[]`, the fingerprint set is empty) — this is **already known and documented** at `content_moderation.py:150-160` and pinned by `test_transcript_is_not_persisted_so_this_check_cannot_fire`. What I add is only the *ordering* observation (R5-11) and the fact that the worker check at `tasks.py:316-333` is the real gate and runs after the flag is already `True`. Fixing that properly means persisting `transcript_text` (tracked as B2b) or a human review queue. |
| **`/admin/` hardening** | `path('admin/', admin.site.urls)` (`EchoFlow/urls.py:7`) is on the public origin with no rate limit, so `/admin/login/` is an unthrottled credential-stuffing target. But no code path sets `is_staff=True`; a staff account requires `manage.py`. So the surface is empty in practice. If the owner ever promotes a user, this becomes live immediately — so **at minimum, do not promote anyone until it is behind auth or an IP allowlist.** |
| **Rate-limit redesign for CGNAT** | `register` at 200/hour/IP and `login` at 10/min/IP are the two remaining IP-keyed limits that hurt legitimate users behind a carrier NAT. Both are reasoned about at length in `throttling.py:1-58` and both have known correct patterns available (per-username, per-token-subject). But changing them changes the abuse ceiling, and that is a judgement call the owner should make with the business constraint (Indian mobile-first, CGNAT-heavy) in view, not a security agent. RECON-02 A-8 already flags it. |
| **`?page=` deep-offset** | Bounded by `statement_timeout=30s` and by the 1000/h `user` bucket. It is a real inefficiency, not an outage. A `MAX_PAGE` cap is a 5-line change with a real risk of breaking a legitimate client that walks pages, so it needs the client's pagination behaviour confirmed first. |
| **`Report`/`Grievance`/`TakedownRequest` free-text caps** | Lower priority than the 500s they cause, and the regulatory-record argument means "we truncated the complaint" needs care. Do the length validation (A-6) and leave storage growth to a retention policy conversation. |
| **CSP enforcement (report-only first)** | Add the header, but ship it in report-only mode for one deploy. A `script-src 'self'` policy will break something — the Google Fonts `<link>` in `frontend/index.html` is `style-src`/`font-src` territory and a common surprise is a missing `style-src`. Getting a CSP wrong in a deploy is worse than having none, because it produces a white screen. |
| **Idempotency keys on `POST /clips/`** | `services/uploads.py:16-18` already names presigned PUT as the fix. It is a protocol change across the API and both clients. Until then the mitigation is client-side retry discipline, which is the frontend agents' lane. |

---

## 15. Disconfirmations

Things in the prior audit, the plan, or the other recon reports that are **wrong or imprecise**. Each was checked against source, not assumed.

1. **AGENTS.md "Open" — "`scrape_audio` and the `scrape_and_import` task are dead at import time … both import license helpers that no longer exist in `ai_ml/scrapers/base.py` … `ai_ml/scrapers/` is gitignored."** **WRONG as of HEAD.** All five helpers exist: `normalize_license` (`base.py:210`), `license_features` (`:257`), `is_noncommercial_license` (`:273`), `license_allows_commercial` (`:317`), `resolve_podcast_rss` (`:352`). `ai_ml/scrapers/state.py` and `log.py` both exist (13 KB / 3.4 KB) and are imported at `scrape_audio.py:44-45`. `git ls-files ai_ml/scrapers` returns **12 tracked files** and `git status ai_ml/` is clean. `.gitignore` has no `ai_ml/scrapers` entry (lines 24-32 checked), and `.dockerignore` explicitly says it is *not* excluded. `scrape_audio.py` parses cleanly. AGENTS.md is describing a state that was fixed and the note was never updated. **Anyone acting on that Open item will re-break a working scraper.** (The A4 licensing gate itself is unaffected either way — it reads DB columns, per AGENTS.md's own note, which is correct.)

2. **AGENTS.md "A comment describing a method that does not exist is worse than no comment" (`ErrorBoundary.tsx:28` claims it sits inside the providers when it sits outside) — the `CORS_URLS_REGEX` claim, already recorded as fixed.** I re-verified the *current* state and it is correct: `settings.py:60` `CORS_URLS_REGEX = r'^(?!/(admin|metrics)/).*$'`, `CORS_ALLOW_ALL_ORIGINS = False` (`:33`), `CORS_ALLOWED_ORIGINS` env-driven (`:28`). No re-report. **But** the fix introduced a side effect nobody has flagged: excluding `/metrics/` from CORS means `/metrics/` is now *less* protected in one respect while still being unauthenticated (R5-10) — the regex was aimed at browser origins and did nothing about direct access.

3. **"Unbounded pagination (`page_size` without a max)."** **NOT APPLICABLE.** In DRF 3.18.0 (`.venv/…/rest_framework/__init__.py`), `PageNumberPagination.page_size_query_param = None` (`pagination.py:175`) and `CursorPagination.page_size_query_param = None` (`:533`). `get_page_size` short-circuits on `if self.page_size_query_param:` (`:257-262`), so `?page_size=1000000` is silently ignored and the fixed `PAGE_SIZE`/10/20 applies. This is a common false positive and I am recording the negative result so it is not re-raised. Only `?page=` (offset) is unbounded.

4. **"The moderation blocklist is empty, so it approves every input"** (`docs/INDIA-REGULATORY-READINESS.md`, ISSUE-04). **STALE.** `_BLOCKED_PHRASES` was rebuilt 2026-09-29 (B2a) to 4 CSAM-specific constructions plus `"csam"` (`content_moderation.py:34-38`), and the fingerprint set `_FINGERPRINT_BLOCKLIST` (`:45-47`) is the thing that is empty. The **outcome** the doc predicted is nonetheless correct for a different reason — see #5 — so the conclusion survives while the stated cause does not.

5. **The proximate cause of "moderation approves everything" is ordering, not an empty list.** `run_moderation_check` is called by `approve-moderation` (`content.py:280`) **before** `trigger_hls_processing` (`:285`). At that moment `clip.transcript` is empty, `clip.tags` is `[]` (KeyBERT runs inside the worker, `tasks.py:288-293`), and the fingerprint set is empty. So all three checks return `(True, None)` and the endpoint returns 200 `{"status": "approved"}` for **every** upload. The real gate is the inline check at `tasks.py:316-333`, which runs **after** `moderation_approved` was already set `True`. `content_moderation.py:150-160` documents the transcript half of this; the *tags* half and the *ordering* consequence (a brief window in which `moderation_approved=True, status='processing'`, and `public_view` at `content.py:394-396` reads that flag alone) are not documented anywhere. That is R5-11.

6. **"A share token is a 30-day media token" — the `is_read`/inbox claim about `ShareEvent` idempotency is fine, but the implied "`send_share` is safe to retry" is not.** There is **no** `unique_together` on `ShareEvent` (`models.py:237-245` has indexes only), and `services/shares.py:31` is a bare `create()`. `record_share` is `get_or_create` and therefore idempotent; the inbox row is not. 100/hour × a client retry = duplicate inbox entries. Nobody has flagged this asymmetry.

7. **My own initial hypothesis about the erasure cooling-off, discarded before reporting.** I expected `data_subject.py:121-123` (`req.status='pending'; req.cooling_off_until = now + 30d; req.save()`) to be an unbounded re-arm of the 30-day DPDP §14 clock. **It is not.** Both branches of `if existing:` return (`:72-78` and `:99-111`) before that code is reached, so the reset only runs on the create path, where the row did not exist. There is no re-arm vector. Recording it because the pattern looks like one and the next reader will make the same assumption.

8. **RECON-02 A-6 (`find_user` enumeration) is correct but incomplete in a way that matters.** It rates the finding on the 200-vs-404 shape and the returned PK. The **crash** is the sharper half and it is not mentioned: because `AbstractUser.username`'s `unique=True` is case-sensitive and `RegisterSerializer` has no `UniqueValidator` on `username`, two case variants can coexist, and `get(username__iexact=…)` then raises an uncaught `MultipleObjectsReturned` (R5-07). The same case-sensitivity gap means `PATCH /profile/me/update/` can claim a visually identical handle (`serializers.py:868-872` uses an exact `filter`).

9. **AGENTS.md's own note on the `ef_hls_token` cookie ("`SameSite=Lax` … blocks cross-site") is slightly imprecise about what Lax does.** Lax permits the cookie on same-site top-level navigations, which is what hls.js needs; it does not permit cross-site subresource requests. The conclusion (Lax, not Strict, is required) is right; the parenthetical is loose. Recording because "Lax permits cookies on same-site top-level navigations, but blocks cross-site" reads as a general property of the attribute when it is a property of the *combination*.

10. **`SECURITY.md` "Known Security Mitigations → Data Protection: User emails are encrypted at rest using Fernet symmetric encryption."** **False.** `models.py:35-51` documents the `encrypted_email` field as removed, with a four-part rationale, and states the plaintext `AbstractUser.email` is the source of truth. A published security policy that asserts a control the code explicitly does not have is a misrepresentation, and it is the kind an auditor or a reporter will check first.

11. **`docs/INDIA-REGULATORY-READINESS.md` ISSUE-01: "RegisterSerializer does **NOT** include `dob`, `consent_accepted`, or `terms_version` fields."** **Stale.** All three are in `Meta.fields` (`serializers.py:613`), `dob` is `required=True` (`:609`, overwriting the `required=False` at `:595`), and `consent_accepted` is `required=True` (`:593`). This was the B1 fix on 2026-09-29; the readiness doc was not updated. ISSUE-04's note has the same staleness (#4).

12. **`docker/nginx.conf:170`: "The hls/ bucket prefix is public-read per docker-compose.yml's `mc anonymous set download .../hls` step."** **False**, and it is the most dangerous stale comment in the repo. `docker-compose.yml:250` says the opposite in as many words ("NOTE: hls/ is intentionally NOT made public"). `media_urls.py`'s module docstring already flags this exact line as stale. If an operator trusted the comment and "fixed" the mismatch by running `mc anonymous set download`, the entire HLS token scheme would be bypassable by anyone who could read the repo. **Delete the comment, do not act on it.**

13. **A `HACK`/`TODO` in `content.py:99-104` claims "per-action parsers cannot be selected here … Reaching for it would silently no-op."** I checked the DRF 3.18 source path this rests on and the reasoning is sound: `APIView.initialize_request` calls `get_parsers()`, and `ViewSetMixin.initialize_request` sets `self.action` only after delegating. Recording as **confirmed, not disconfirmed** — the working agreement asks for both, and this is one of the few comments in the repo that is exactly right about a DRF internal.

---

## 16. Open questions for the owner

1. **`Report` and `TakedownRequest` cascade-delete (A-10) — is evidence destruction by the respondent acceptable for v1?** Moving them to `SET_NULL` is a 1-line-per-model change plus a migration, but it means a complaint outlives the content, which changes what the operator queue shows (rows referencing a deleted clip). I would fix it, but it is a data-retention decision and IT Rules R3(2) is specific enough that you should own the interpretation.

2. **Unverified `requester_email` / `user_email` on takedown and grievance (A-11) — what is the intended v1 posture?** The endpoints exist to satisfy IT Rules R3. Leaving them wide open makes the regulator-facing channel a harassment and censorship weapon. Adding verification needs a mail backend, which the repo explicitly has none of (`RegisterSerializer`'s `minor_consent_verified` HACK says so). So the honest options are: (a) accept and document, (b) stop honouring the claimed address for SLA purposes while still recording it, (c) add a mail backend. **(b) is available today and I recommend it** — it closes the SLA-abuse half with no new infrastructure.

3. **Should `/admin/` be reachable from the public origin at all?** It is unthrottled, unauthenticated at the login form, and serves a distinguishable 302. No account is `is_staff` today. Do you want an IP allowlist now, or is "never promote anyone" an accepted control?

4. **Is the `X-Real-IP` → `AuditLog.ip_address` chain correct behind Cloudflare?** `client_ip.py` prefers `X-Real-IP`, which nginx sets from `$remote_addr` — correct only if nginx is the *first* hop. In the stated production topology (`app.echoflow.in` on Pages → `api.echoflow.in` presumably also behind Cloudflare), `$remote_addr` at nginx would be the **Cloudflare edge IP**, and every audit row for every user would share a handful of values. If Cloudflare fronts the API, `nginx` needs `set_real_ip_from` + `real_ip_header CF-Connecting-IP`, and until then the CERT-In identity-retention claim rests on an IP that identifies the CDN. **I could not determine this from the repo** — there is no Cloudflare config here. Please confirm the production edge topology.

5. **`flushexpiredtokens` (RECON-02 A-9) — daily or hourly, and does the Beat schedule get a new entry or a management command in the existing daily cron?** Trivial mechanically; I am asking because the answer constrains the `AuditLog` retention task you will also need (one `AuditLog` row per HTTP request, no pruning — §7.5), and they should probably be designed together.

6. **Do you want the moderation flag inverted in time (set `False`, let the worker set `True`) or persisted (add `transcript_text`, re-check after the worker)?** R5-11's fix is a one-line reordering, but a reordering means the clip is invisible between upload and HLS completion — which may break the mobile upload pipeline's status polling that `clip_read: 120/min` was sized for. The alternative (persist the transcript, B2b) is a migration but preserves current behaviour. I lean toward the reorder **plus** a `status='processing'` check in `public_view`, but it touches the upload UX and that is your call.

7. **Is the `GET /feed/` publish-on-empty behaviour (A-9/§7.2) intentional as a cold-start latency optimisation, or an artefact?** If the latter, a `SETNX` debounce is uncontroversial. If the former — i.e. you specifically want every empty read to re-publish — then the fix is a scope on `FastFeedViewSet` instead, and I should not change the semantics. I could not find a decision record for it in `docs/EXPLAIN/`.

8. **Should `share_link` require `status='ready'`?** Today it does not (`content.py:445` checks only `moderation_approved`), relying on `clip_storage_key` returning `None` → 409. That works, but a `status='ready'` check would be more honest and would survive a future change to the key derivation. Cosmetic-or-not is your judgement; I lean yes for consistency with `send_share` (`social.py:167`).

---

**Nothing was modified.** `git status` at the start showed only `mobile/` changes (`jest.config.js`, `jest.setup.js`, `store/player.test.ts`, `store/player.ts`, `lib/__tests__/reanimatedHarness.test.tsx`) plus untracked `docs/frontend/` — all belonging to the parallel agent whose lane I was told to stay out of. I did not read, write, or touch `mobile/` or `docs/mobile/`. `ai_ml/scrapers/base.py:10` mentions a `fixer` function in a comment, which I did not act on — flagging it as a possible parallel-agent artifact rather than a pre-existing issue.
</task_result>
</task>