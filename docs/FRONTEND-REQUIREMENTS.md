# EchoFlow — Frontend Requirements (Authoritative Spec)

> **Source of truth:** every requirement in this document is derived from the
> current backend code (`backend/app/`, `backend/EchoFlow/`, `ai_ml/`). The
> README and product vision were NOT used to infer features. Where the existing
> frontend (`frontend/sample_frontend/`) differs from the backend contract, the
> gap is called out explicitly.

**Stack assumed by the backend (so the frontend must comply):**

- All requests cross the **nginx TLS terminator** (`nginx:443` → gunicorn).
  Browsers reach the API at `https://<host>` — never raw `http://gunicorn:8000`.
  See `docker/nginx.conf` and `docs/EXPLAIN/docker/05-https-tls-termination.md`.
- `PUBLIC_MEDIA_ENDPOINT_URL` (the browser-reachable HLS base) is served over
  **HTTPS** from `nginx:9443` (MinIO HLS prefix is bucket-policy public; see
  `backend/app/media_urls.py:43-59`). HLS playback URLs returned by the API are
  already absolute HTTPS URLs — the client must use them verbatim, not prefix
  the API base.
- `DJANGO_DEBUG=False` is required behind nginx (`backend/EchoFlow/settings.py:608-618`).
  `SECURE_SSL_REDIRECT=True`, `SESSION/CSRF_COOKIE_SECURE=True`,
  `SECURE_HSTS_PRELOAD=True`. The frontend must therefore run on `https://` and
  the browser must send `Authorization: Bearer <jwt>` (NOT cookies) for auth.
- Auth is JWT (`rest_framework_simplejwt`), NOT session/cookie auth.
  Access token TTL = 15 min, refresh TTL = 7 days (`settings.py:543-553`).
  Refresh rotates + blacklists after use (`ROTATE_REFRESH_TOKENS=True`).

**Status legend used throughout this document:**

| Tag | Meaning |
| --- | --- |
| **Implemented** | The existing `sample_frontend` already wires this correctly. |
| **Partially implemented** | Some calls exist but the contract is incomplete or subtly wrong. |
| **Missing** | Backend supports it; the frontend has no consumer. |
| **Backend capability, no frontend consumer** | Backend exposes this; frontend is unaware. |
| **Frontend behavior unsupported by backend** | Frontend assumes something the backend does not provide. |

---

## 1. Backend surface (the spec)

### 1.1 URL map

All routes are mounted under `backend/app/urls.py` (included at `/` by
`backend/EchoFlow/urls.py`). The router is a `DefaultRouter`.

| Verb + path | View / action | Permission | Throttle scope | Source |
| --- | --- | --- | --- | --- |
| `POST /auth/register/` | `RegisterView` | AllowAny | `register` (200/hour, IP) + `register_username` (3/hour, username) | `backend/app/views/auth.py` |
| `POST /auth/login/` | `ThrottledTokenObtainPairView` (SimpleJWT) | AllowAny | `login` (10/min) | `backend/app/urls.py:17` |
| `POST /auth/token/refresh/` | `ThrottledTokenRefreshView` (SimpleJWT) | AllowAny | `token_refresh` (120/hour, keyed on the **verified** user_id in the token) | `backend/app/urls.py` |
| `POST /auth/logout/` | `LogoutView` (blacklists refresh) | IsAuthenticated | (default) | `backend/app/urls.py:35-51` |
| `GET /feed/` | `FastFeedViewSet.list` | IsAuthenticated | (default) | `backend/app/views/feed.py:60-142` |
| `GET /suggestions/` | `SuggestionViewSet.list` | IsAuthenticated | (default) | `backend/app/views/feed.py:145-197` |
| `POST /tags/initialize/` | `TagsViewSet.initialize_vectors` | IsAuthenticated | (default) | `backend/app/views/feed.py:200-249` |
| `GET /clips/` | `AudioUploadViewSet.list` | IsAuthenticated | `upload` (20/hour) | `backend/app/views/content.py:14-43` |
| `POST /clips/` | `AudioUploadViewSet.create` | IsAuthenticated | `upload` (20/hour) | `backend/app/views/content.py:27-43` |
| `PATCH /clips/{id}/` | `AudioUploadViewSet.partial_update` | IsAuthenticated | `upload` | `backend/app/views/content.py:45-60` |
| `PUT /clips/{id}/` | `AudioUploadViewSet.update` | IsAuthenticated | `upload` | `backend/app/views/content.py:45-60` |
| `DELETE /clips/{id}/` | `AudioUploadViewSet.destroy` | IsAuthenticated | (default) | router |
| `POST /interactions/{id}/toggle-like/` | `ClipInteractionViewSet.toggle_like` | IsAuthenticated | `interaction` (60/min) | `backend/app/views/interactions.py:28-33` |
| `POST /interactions/{id}/register-skip/` | `ClipInteractionViewSet.register_skip` | IsAuthenticated | `interaction` | `backend/app/views/interactions.py:35-47` |
| `POST /interactions/{id}/log-telemetry/` | `ClipInteractionViewSet.log_telemetry` | IsAuthenticated | `telemetry` (60/min) | `backend/app/views/interactions.py:49-61` |
| `GET /comments/` | `CommentViewSet.list` (filterable) | IsAuthenticated | `comment` (60/hour) | `backend/app/views/comments.py:40-80` |
| `POST /comments/` | `CommentViewSet.create` | IsAuthenticated | `comment` | `backend/app/views/comments.py:66-74` |
| `GET /comments/{id}/` | `CommentViewSet.retrieve` | IsAuthenticated | `comment` | router |
| `PATCH /comments/{id}/` | `CommentViewSet.partial_update` (author-only) | IsAuthenticated | `comment` | `backend/app/views/comments.py:27-37,76-77` |
| `DELETE /comments/{id}/` | `CommentViewSet.destroy` (author-only) | IsAuthenticated | `comment` | `backend/app/views/comments.py:79-80` |
| `GET /share/` | `ShareViewSet.list` (inbox) | IsAuthenticated | `share_poll` (1000/hour) | `backend/app/views/social.py:42-43` |
| `GET /share/{id}/` | `ShareViewSet.retrieve` | IsAuthenticated | `share_poll` | `backend/app/views/social.py` |
| `DELETE /share/{id}/` | `ShareViewSet.destroy` | IsAuthenticated | `share_poll` | router |
| `GET /share/find-user/?username=X` | `ShareViewSet.find_user` | IsAuthenticated | `share_poll` | `backend/app/views/social.py:63-74` |
| `POST /share/{clip_id}/send-share/` | `ShareViewSet.send_share` | IsAuthenticated | `share_send` (100/hour) | `backend/app/views/social.py:76-85` |
| `DELETE /share/{id}/share-delete/` | `ShareViewSet.share_delete` | IsAuthenticated | `share_poll` | `backend/app/views/social.py:87-90` |
| `POST /share/{id}/mark-read/` | `ShareViewSet.mark_read` | IsAuthenticated | `share_poll` | `backend/app/views/social.py:92-95` |
| `GET /share/inbox/` | `ShareViewSet.inbox` | IsAuthenticated | `share_poll` | `backend/app/views/social.py:97-106` |
| `GET /share/unread-count/` | `ShareViewSet.unread_count` | IsAuthenticated | `share_poll` | `backend/app/views/social.py:108-111` |
| `POST /follow/{user_id}/toggle-follow/` | `FollowViewSet.toggle_follow` | IsAuthenticated | (default) | `backend/app/views/social.py:114-129` |
| `GET /profile/me/` | `ProfileViewSet.me` | IsAuthenticated | (default) | `backend/app/views/profile.py:29-33` |
| `PATCH /profile/me/update/` | `ProfileViewSet.update_me` | IsAuthenticated | (default) | `backend/app/views/profile.py:35-43` |
| `GET /profile/{id}/` | `ProfileViewSet.retrieve` | IsAuthenticated | (default) | `backend/app/views/profile.py:45-55` |
| `GET /profile/{id}/clips/` | `ProfileViewSet.user_clips` | IsAuthenticated | (default) | `backend/app/views/profile.py:57-74` |
| `GET /health/` | `health_check` | AllowAny | none | `backend/EchoFlow/health.py:9-17` |
| `GET /ready/` | `readiness_check` | AllowAny | none | `backend/EchoFlow/health.py:20-41` |
| `GET /metrics/` | `ExportToDjangoView` (Prometheus) | (no auth) | none | `backend/EchoFlow/urls.py:13` |

> Note: the DRF router **does not expose `POST /share/`** as a create.
> `ShareViewSet` is `ListModelMixin + RetrieveModelMixin + DestroyModelMixin +
> GenericViewSet` (no `CreateModelMixin`), so `POST /share/` returns 405
> (`backend/app/views/social.py:29-34`). The only legitimate share-create path
> is `POST /share/{clip_id}/send-share/`.

> `AudioUploadViewSet.update()` strips `original_file` from the request body
> before the serializer runs (`backend/app/views/content.py:45-60`). Re-uploading
> the audio is **not** allowed via PATCH/PUT — clients must DELETE + POST again.
> Title/category on existing clips are still mutable.

### 1.2 Response shapes (canonical)

#### `GET /feed/` — FastFeedViewSet.list
Source: `backend/app/views/feed.py:60-142`. Three distinct outcomes the frontend
must handle:

1. **Normal (200):**
   ```json
   {
     "next": "auto_trigger",
     "queue_health": <int>,
     "results": [<FeedClipSerializer>, ...]
   }
   ```
   - `results` is 0–10 items (`redis_client.lpop(redis_key, 10)`).
   - `queue_health` is the remaining items in the user's per-user Redis queue.
   - `next: "auto_trigger"` is a sentinel, not a URL.

2. **Cold / queue-empty (202 Accepted):**
   ```json
   {
     "results": [],
     "message": "Preparing your feed...",
     "retry_after_ms": 1500,
     "degraded": true
   }
   ```
   - Returned when the user's queue was empty AND the immediate post-refill
     lpop was also empty. The frontend **must poll again** after
     `retry_after_ms` (~1.5 s).

3. **Redis outage / SQL fallback (200):**
   ```json
   {
     "next": "auto_trigger",
     "queue_health": 0,
     "degraded": true,
     "results": [<trending clip>, ...]
   }
   ```
   - `results` is the top 20 clips by `engagement_velocity` across the
     catalog. The frontend should treat this as a normal feed but may show
     a "degraded" indicator.

#### `FeedClipSerializer` (used in `/feed/`, `/suggestions/`, `/profile/{id}/clips/`,
`liked_clips` inside `/profile/me/`)
Source: `backend/app/serializers.py:132-167`.

```json
{
  "id": "<uuid>",
  "title": "<str>",
  "creator_name": "<str>",
  "creator_id": <int>,
  "category": "<str>",
  "hls_playlist_url": "https://<host>:<port>/<bucket>/hls/<clip_id>/master.m3u8" | null,
  "likes": <int>,
  "shares": <int>,
  "skips": <int>,
  "comment_count": <int>,
  "is_liked": <bool>
}
```

- `hls_playlist_url` is **always** a fresh, absolute HTTPS URL — the
  serializer generates it per-request via `get_hls_playback_url()`
  (`backend/app/media_urls.py:43-59`). It is bucket-policy public, NOT
  presigned. The frontend MUST NOT prefix any API base or sign it.
- `is_liked` is true iff a `UserInteraction(user=me, clip=X,
  interaction_type='like', is_active=True)` row exists. The query is
  pre-annotated at the queryset level by `FastFeedViewSet` so this is
  free of N+1 in normal paths; in `SuggestionViewSet` and
  `ProfileViewSet.user_clips` the same annotation is applied
  (`backend/app/views/feed.py:106-114, 194-197`).
- Counters (`likes`, `shares`, `skips`, `comment_count`) are denormalized
  BigInts on `AudioClip` with DB-level `>= 0` CheckConstraints
  (`backend/app/models.py:102-107`). In **Phase 1** (default), every write
  through `UserInteraction.save()` increments them via `F()` plus a
  Redis-side counter; in **Phase 2** (when
  `ECHOFLOW_DUAL_WRITE_COUNTERS=False`), the `F()` is bypassed and only the
  Redis flusher `flush_counters_to_pg` updates them
  (`backend/app/tasks.py:1086-1136`, run every 5 min via Beat). Counters can
  therefore be stale by up to 5 min in Phase 2 — UI must not assume
  strict-time accuracy.

#### `GET /suggestions/?category=X` — SuggestionViewSet
Source: `backend/app/views/feed.py:145-197`. Paginated via
`FeedCursorPagination` (`backend/app/views/_pagination.py:5-7`,
`page_size=10`, ordering `-created_at`, returns DRF cursor envelope
`{next, previous, results}`).

- `?category` defaults to `'all'`. The backend sanitizes it to a-z/0-9/_/-/32 chars
  before using it as a Prometheus label
  (`backend/app/views/feed.py:172-173`). Empty / unknown categories return the
  full ready-clip catalog.
- Ranking: cosine distance on `semantic_vector + acoustic_vector`, ordered by
  sum ascending. Falls back to `engagement_velocity` on any error
  (`backend/app/views/feed.py:176-192`).
- The vector search reads from the user's cached user-vectors key
  `user_vectors:{id}` (15-min TTL; invalidated on every like/skip/share — see
  §4.5). Cold users (no interactions) get an empty vector → ranking uses
  catalog-wide order; in practice this returns the same as the fallback.

#### `POST /clips/` — AudioUploadViewSet.create
Source: `backend/app/views/content.py:27-43`. Returns:

```json
HTTP/1.1 202 Accepted
{
  "message": "Audio uploading and processing in background.",
  "clip_id": "<uuid>",
  "status": "processing"
}
```

Multipart form fields:

| Field | Required | Type | Validation |
| --- | --- | --- | --- |
| `original_file` | yes | file (`.mp3 .wav .ogg .flac .m4a .aac .webm .opus`) | ≤ 100 MB, magic-byte MIME sniff (rejects non-`audio/*` non-octet-stream), `ffmpeg`/`pydub` duration probe ≤ 300 s (`MAX_DURATION_SECONDS`) |
| `title` | yes | string ≤ 255 chars | (model CharField) |
| `category` | yes (recommended) | string ≤ 50 chars | not validated against a closed enum — see §5.5 |
| `status` | (read-only) | literal `"processing"` | serializer marks it read-only |

`AudioUploadSerializer.validate_original_file`
(`backend/app/serializers.py:48-125`) reads up to 8 KB for the magic-byte
sniff and **reads the entire file into memory** for the `pydub` duration
probe — this is a known memory pressure trade-off (see inline HACK at
`backend/app/serializers.py:91-96`).

Errors come back as DRF validation 400:

```json
{
  "original_file": ["File exceeds 100MB limit."],
  "title": ["..."],
  ...
}
```

The frontend must surface **field-keyed** errors, not just `detail`.

#### `POST /interactions/{id}/toggle-like/`
Source: `backend/app/views/interactions.py:28-33` →
`services.interactions.record_like_toggle`
(`backend/app/services/interactions.py:133-163`).

```json
HTTP/1.1 200 OK
{ "status": "liked" | "unliked" }
```

Behavior contract:
- `get_or_create(user, clip, type='like', defaults={'is_active': True})`.
  If new row → `is_active=True` (liked). If existing → toggle `is_active`.
- `is_active` state change triggers an `AudioClip.likes` increment via
  the `F()` in `UserInteraction.save()` (`backend/app/models.py:186-239`).
  In **Phase 1** this is a synchronous F() UPDATE on the row; in
  **Phase 2** (`ECHOFLOW_DUAL_WRITE_COUNTERS=False`) the F() is bypassed
  and the counter flush task is the only writer.
- Idempotency: re-pressing the same state (e.g. POST twice while
  `is_active=False`) does NOT re-decrement — `UserInteraction.save()`
  detects no state change (`backend/app/models.py:197-200`).
- Cache invalidation (`user_vectors:{user_id}`) is registered via
  `transaction.on_commit` — only fires if the surrounding transaction
  commits. UI doesn't need to do anything special.
- The response `status` text is the new state of the row, but
  `UserInteraction` has only ONE row per `(user, clip, type)` (model
  `unique_together`), so this is also the canonical like state.

#### `POST /interactions/{id}/register-skip/`
Source: `backend/app/views/interactions.py:35-47` →
`services.interactions.record_skip`
(`backend/app/services/interactions.py:166-193`).

Body (`SkipActionSerializer`):

```json
{
  "listen_duration_ms": <int >= 0>,
  "reel_position_ms":   <int >= 0>,
  "reel_id":            "<uuid>"
}
```

- `completion_rate = min(listen_duration_ms / expected_duration, 1.0)` where
  `expected_duration = reel_position_ms if reel_position_ms > 0 else 60000`.
  A missing `reel_position_ms` is silently treated as 60 s — the frontend
  should always send the actual reel position to keep `completion_rate`
  honest.
- `interaction_type='skip'` (was `'view'` historically — fixed in audit pass 3).
- Returns `201 Created {"status": "skip/view registered"}`.

#### `POST /interactions/{id}/log-telemetry/`
Source: `backend/app/views/interactions.py:49-61` →
`services.interactions.record_telemetry`
(`backend/app/services/interactions.py:196-250`).

Body (`InteractionTelemetrySerializer`):

```json
{
  "action_type": "view" | "like" | "share" | "skip",
  "watch_time_ms": <int in [0, 36_000_000]>
}
```

- 10-hour watch_time cap is a server-side abuse guard
  (`backend/app/serializers.py:218-219`).
- Returns `202 Accepted {"status": "telemetry logged"}`.
- **Async path.** The event is `XADD`'d to Redis Stream
  `stream:interaction.events` with consumer group `cg:telemetry-flush`
  (every 10 s, Beat-driven). The `flush_telemetry_stream` task
  (`backend/app/tasks.py:584-796`) dedups via
  `processed_event:{event_id}` SETNX (24 h TTL), bulk-inserts into
  `UserInteraction`, XACKs, and DLQ-routes poison messages to
  `stream:interaction.events:dlq`. The list-based fallback path
  `flush_telemetry_legacy` exists for `ECHOFLOW_TELEMETRY_STREAM=off`
  (`backend/app/tasks.py:517-581`, every 30 s).
- On Redis hiccup: falls back to synchronous `update_or_create` into
  `UserInteraction` and invalidates the user's `user_vectors:{id}` cache
  inline (`backend/app/services/interactions.py:227-249`).
- Throttled at `telemetry = 60/min` — a sustained 1 Hz client will start
  receiving 429s after ~60 s. UI must back off and re-queue dropped events
  rather than spam.

#### `GET /comments/?clip={uuid}&parent={uuid}`
Source: `backend/app/views/comments.py:40-80`. Returns the DRF
`CommentCursorPagination` envelope (page_size=20, `-created_at`):
`{next, previous, results}`.

`CommentSerializer` (`backend/app/serializers.py:178-211`):

```json
{
  "id": "<uuid>",
  "clip": "<clip uuid>",
  "author_username": "<str>",
  "parent": "<comment uuid>" | null,
  "text": "<str ≤ 500, control chars stripped, NUL rejected>",
  "reply_count": <int>,        // 0 for replies, count of replies for top-level
  "created_at": "<iso8601>"
}
```

- Top-level comments bump `AudioClip.comment_count` via `F()` in
  `Comment.save()` (`backend/app/models.py:121-126`). Replies do NOT
  increment.
- Replies can be nested arbitrarily (no `parent` depth cap). The UI
  should choose a depth to render — there is no backend pagination on
  replies; only top-level comments are paginated via `?parent=null`.
- `validate_text` strips ASCII control chars and rejects NUL bytes; UI
  can pre-strip but should not rely on it.
- `IsAuthorOrReadOnly` (`backend/app/views/comments.py:27-37`) blocks
  non-author PATCH/DELETE → 403. Reads are public. `get_queryset()`
  also scopes writes to comments owned by the requester, so non-author
  PATCH/DELETE also returns 404 (defense in depth, lines 54-64).

#### `POST /share/{clip_id}/send-share/`
Source: `backend/app/views/social.py:76-85` →
`services.shares.send_share` (`backend/app/services/shares.py:27-31`).

Body (`ShareActionSerializer`, free-form here, not via serializer — see
`views/social.py:79`):

```json
{ "receiver_id": <int> }
```

Errors:
- 400 `{"error": "Receiver ID required"}`
- 404 (User / AudioClip not found)
- 400 `{"error": "You can't share with yourself"}` — enforced at the
  `find-user` step, not at send-share (self-share attempt reaches the
  service which doesn't reject it; UI should validate before submitting).

Returns `201 Created {"status": "shared successfully"}`.

#### `GET /share/find-user/?username=X`
Source: `backend/app/views/social.py:63-74`.

```json
HTTP/1.1 200 OK
{ "id": <int>, "username": "<str>" }
```

Errors:
- 400 `{"error": "Username required"}` (empty query string)
- 404 `{"error": "No user found: @<x>"}`

`username__iexact` is used (case-insensitive). The endpoint exists
specifically to resolve `@handle` → user_id before `send-share`.

#### `GET /share/inbox/`
Source: `backend/app/views/social.py:97-106`. Returns a **plain list**
(not a paginated envelope):

```json
[<ShareEventSerializer>, ...]
```

`ShareEventSerializer` (`backend/app/serializers.py:221-243`):

```json
{
  "id": <int>,
  "sender_name": "<str>",
  "clip": <FeedClipSerializer>,           // full nested clip object
  "clip_title": "<str>",
  "clip_hls_url": "https://...",           // absolute HTTPS, fresh per-request
  "created_at": "<iso8601>",
  "is_read": <bool>
}
```

`order_by('-created_at')` — newest first.

#### `GET /share/unread-count/`
Source: `backend/app/views/social.py:108-111`:

```json
{ "unread": <int> }
```

Throttled at `share_poll = 1000/hour`. Designed for cheap polling.

#### `POST /share/{id}/mark-read/`
Source: `backend/app/views/social.py:92-95`. Returns `204 No Content`.
**Note the action method is `POST` in the codebase**, not PATCH — the
sample_frontend uses `PATCH` (`frontend/sample_frontend/src/api/client.ts:137`)
which **gets 405 Method Not Allowed**.

#### `DELETE /share/{id}/share-delete/`
Source: `backend/app/views/social.py:87-90`. Returns `204 No Content`.
Filter is `receiver=request.user` — a sender cannot delete a share they
sent; only the recipient can remove it from their inbox.

#### `POST /follow/{user_id}/toggle-follow/`
Source: `backend/app/views/social.py:121-128` →
`services.follows.toggle_follow`
(`backend/app/services/follows.py:14-19`).

```json
HTTP/1.1 200 OK or 201 Created
{ "status": "followed" | "unfollowed" }
```

- Self-follow returns `400 {"error": "You cannot follow yourself."}`.
- The status code distinguishes: 201 = first-time follow, 200 = unfollow.
  (The frontend currently ignores this; should toggle label accordingly.)

#### `GET /profile/me/`
Source: `backend/app/views/profile.py:29-33`. Returns
`OwnProfileSerializer` (`backend/app/serializers.py:282-322`):

```json
{
  "id": <int>,
  "username": "<str>,
  "profile_picture": "<file path>" | null,
  "followers_count": <int>,
  "following_count": <int>,
  "uploads_count": <int>,
  "liked_clips": [<FeedClipSerializer>, ...],   // most-recent 50 active likes
  "date_joined": "<iso8601>"
}
```

`liked_clips` is annotated with `user_has_liked` (already true since
the viewer is the same user) and capped at 50 results.

#### `PATCH /profile/me/update/`
Source: `backend/app/views/profile.py:35-43`. Multipart form fields
(`ProfileUpdateSerializer`, `backend/app/serializers.py:324-333`):

| Field | Type | Notes |
| --- | --- | --- |
| `username` | str | validated unique (excluding self) |
| `profile_picture` | file | uploaded to `avatars/` prefix in S3; **no size/MIME validation** on this serializer — the frontend must validate before upload |

Returns `OwnProfileSerializer`-shaped object.

#### `GET /profile/{id}/`
Source: `backend/app/views/profile.py:45-55`. Returns
`PublicProfileSerializer` (`backend/app/serializers.py:268-280`):

```json
{
  "id": <int>,
  "username": "<str>",
  "profile_picture": "<file path>" | null,
  "followers_count": <int>,
  "following_count": <int>,
  "uploads_count": <int>,
  "date_joined": "<iso8601>"
}
```

NO `liked_clips`, NO `email` on public profiles (this is intentional).

#### `GET /profile/{id}/clips/`
Source: `backend/app/views/profile.py:57-74`. Cursor-paginated
(`FeedCursorPagination`, `page_size=10`):

```json
{ "next": "<cursor>", "previous": "<cursor>", "results": [<FeedClipSerializer>, ...] }
```

Only `status='ready'` clips are listed; `processing` and `failed`
clips are not exposed.

#### `POST /tags/initialize/`
Source: `backend/app/views/feed.py:200-249`. Body:

```json
{ "selected_tags": ["tag1", "tag2", ...] }
```

- Empty list → `400 {"error": "Not enough data to build baseline."}`.
- Non-empty → averages the top-100 `status='ready'` clips matching ANY
  selected tag (via `tags @> '["tag"]'::jsonb`, see
  `backend/app/views/feed.py:225-236`) into `User.long_term_semantic`
  and `User.long_term_acoustic`, then schedules
  `refill_user_feed(user.id, count=30)` via the publish helper.
- Returns `200 OK {"status": "Algorithm initialized. Feed is ready."}`.
- This endpoint should be called **once** at onboarding. Re-calling
  resets the long-term vector — the frontend should NOT re-call on every
  cold-start re-render.

### 1.3 Authentication contract

- `POST /auth/login/` body: `{username, password}` → `{access, refresh, ...}`
  (SimpleJWT default — `access` and `refresh` strings).
- `POST /auth/register/` body: `{username, password, email}` (see
  `RegisterSerializer`, `backend/app/serializers.py:246-266`):
  - `username`: required (inherited AbstractUser validation)
  - `email`: required, must be unique (UniqueValidator),
    `write_only=True` — it WILL NOT come back in the response
  - `password`: required, `write_only=True`
  - The response body is the **User** (id, username, email) — NOT a JWT.
    The frontend must `login()` after `register()` to obtain tokens.
- `POST /auth/token/refresh/` body: `{refresh}` → `{access, refresh (new)}`
  (ROTATE_REFRESH_TOKENS=True; the OLD refresh is blacklisted). The
  frontend MUST update its stored refresh token on every refresh
  (`backend/EchoFlow/settings.py:546-553`).
- `POST /auth/logout/` body: `{refresh}` → `{detail: "logged out"}` or
  `{detail: "invalid refresh token"}` (HTTP 400). Blacklists the
  refresh; access token expires in ≤ 15 min anyway.
- All other endpoints expect `Authorization: Bearer <access_token>`.
  401 → must refresh; 401-after-refresh-fail → must clear local state
  and route to login.
- Password validation: Django's four built-in validators
  (`AUTH_PASSWORD_VALIDATORS` at `backend/EchoFlow/settings.py:324-337`):
  - `UserAttributeSimilarityValidator` (rejects passwords containing
    username/first/last/email)
  - `MinimumLengthValidator` (default ≥ 8 chars)
  - `CommonPasswordValidator` (rejects top-1000 common passwords)
  - `NumericPasswordValidator` (rejects entirely-numeric passwords)
- Login throttled at **10/min/IP** — a credential-stuffing defense. The
  frontend must rate-limit login attempts (e.g., 1/sec with a cooldown
  on 429).

### 1.4 CORS, cookies, TLS

- `CORS_ALLOWED_ORIGINS` is env-driven and **must be `https://...`**
  (`backend/EchoFlow/settings.py:28-33`). The example default
  `http://localhost:5173` will fail preflight once the nginx terminator
  is live. Frontend deployments must use `https://` (Vite dev behind
  a TLS-aware proxy).
- `CORS_ALLOW_ALL_ORIGINS = False` (hard-coded).
- `CORS_URLS_REGEX = r'$.^'` — never matches. CORS is purely origin-based.
- `CORS_ALLOW_HEADERS` includes `range` (critical for HLS partial-content
  requests) and `CORS_EXPOSE_HEADERS` includes `Content-Range` /
  `Accept-Ranges` (`settings.py:58-69`). The frontend does not need to
  set these explicitly when using fetch + HLS.js, but if it constructs
  custom requests it must include `Range` when seeking a segment.
- Auth is NOT cookie-based in normal flow. The frontend uses
  `sessionStorage` (current `sample_frontend` does so). JWT is in the
  `Authorization` header.
- `DJANGO_DEBUG=False` makes `SESSION/CSRF_COOKIE_SECURE=True` and
  `SECURE_SSL_REDIRECT=True`. CSRF is therefore irrelevant for the
  JWT-bearer frontend, but `CSRF_COOKIE_HTTPONLY` is NOT set, so cookies
  are JS-accessible if anyone ever falls back to them. Don't.

### 1.5 Domain model & relationships

| Model | Key fields | Source |
| --- | --- | --- |
| `User` (AbstractUser) | `id (BigInt)`, `username`, `email` (unique), `password`, `following` (M2M self), `long_term_semantic` (VectorField 384-d), `long_term_acoustic` (VectorField 128-d), `profile_picture` (ImageField → `avatars/`) | `backend/app/models.py:14-35` |
| `AudioClip` | `id (UUID)`, `creator (FK User)`, `title`, `category` (CharField 50, no enum constraint), `original_file` (FileField → `uploads/YYYY/MM/DD/`), `hls_playlist_url` (CharField 500, the **object key**), `source_name/source_url/license/attribution_text`, `imported_via_scraper`, `original_source_id`, `duration_ms` (int), `avg_completion_rate` (float), `engagement_velocity` (float), `likes/shares/skips/comment_count` (BigInt, ≥0), `tags` (JSONField list of str), `semantic_vector` (VectorField 384-d), `acoustic_vector` (VectorField 128-d), `status` (`processing|ready|failed`), `created_at` | `backend/app/models.py:39-107` |
| `Comment` | `id (UUID)`, `clip (FK)`, `author (FK User)`, `parent (FK self, nullable)`, `text` (CharField 500), `created_at` | `backend/app/models.py:109-131` |
| `ShareEvent` | `id (BigInt)`, `sender (FK User)`, `receiver (FK User)`, `clip (FK)`, `created_at`, `is_read` (bool) | `backend/app/models.py:133-141` |
| `UserInteraction` | `user (FK)`, `clip (FK)`, `interaction_type` (`like|share|skip|view`), `is_active` (bool), `watch_time_ms` (int), `completion_rate` (float), `updated_at`, `created_at`. `unique_together=(user, clip, interaction_type)` | `backend/app/models.py:143-239` |

Cascading: deleting a `User` CASCADE-deletes their `AudioClip`s (which
runs the `post_delete` signal that removes `original_file` and the
`hls/<id>/` prefix — `backend/app/signals.py:29-95`). Deleting an
`AudioClip` cascades to `Comment` and `ShareEvent` rows but **NOT** to
`UserInteraction` rows (no `on_delete` override, so default is CASCADE
because the FK is declared without one — verify before relying).

`liked_clips` in `OwnProfileSerializer` is a derived list, not a
back-reference. There is no `is_liked` shortcut on `User`.

### 1.6 Async / background-job behavior

The frontend MUST reason about these async paths:

| Trigger | Celery task | Queue | Latency budget | Frontend implication |
| --- | --- | --- | --- | --- |
| `POST /clips/` | `process_audio_to_hls(clip_id)` | `heavy_media` | ~5–60 s typical; up to ~600 s (HLS_BUCKETS) | Show "processing" UI state for the clip. The clip will NOT appear in feed/list endpoints until `status='ready'` (lists filter on ready in `/profile/{id}/clips/`, `/suggestions/`; `/feed/` queue is fed by `refill_user_feed` which only considers ready clips via `feed_pool.py`). |
| `GET /feed/` (cold) | `refill_user_feed(user_id, count=40)` (publishes to `fast_feed`) | `fast_feed` | 1–2 s typical | Server returns 202 with `retry_after_ms: 1500`. Frontend must poll again. |
| `POST /tags/initialize/` | `refill_user_feed(user_id, count=30)` (publishes to `fast_feed`) | `fast_feed` | 1–2 s after the response | The 200 response is returned synchronously; the user queue is populated async. The next `/feed/` call (post-`retry_after_ms` or immediate) will return the new clips. |
| `POST /interactions/{id}/log-telemetry/` | `flush_telemetry_stream` (Beat, every 10 s) | `default` | up to 10 s + dedup | UI must NOT rely on telemetry events being immediately observable in `/feed/` ranking. Counters do not update from telemetry. |
| `POST /share/{id}/send-share/` | None directly. The interaction counter increments synchronously; the recipient's notification is a `ShareEvent` row written in the same transaction. | n/a | immediate | The recipient's `GET /share/unread-count/` will reflect the new share on the next poll (≤ 30 s in current `sample_frontend`). |
| Beat | `update_global_metrics` (every 5 min) | `default` | n/a | `engagement_velocity` / `avg_completion_rate` are stale by up to 5 min. |
| Beat | `evolve_long_term_user_baselines` (daily) | `default` | n/a | `User.long_term_semantic/acoustic` are recomputed for active users. |
| Beat | `cleanup_stuck_processing` (every 5 min) | `default` | n/a | Re-enqueues clips stuck in `processing` for > 15 min. After 45 min the clip is flipped to `status='failed'`. |
| Beat | `rebuild_global_exploit_pool` (every 5 min) | `default` | n/a | The `clip:candidates:exploit` ZSET is refreshed; affects exploit side of feed. |
| Beat | `dispatch_user_pool_rebuilds` (hourly) | `default` | n/a | Fans out `rebuild_user_explore_pool(user_id)` across the next hour with jittered `countdown`s. Affects explore side of feed. |
| Beat | `cleanup_orphan_hls` (03:00 UTC, crontab) | `default` | n/a | Defense-in-depth: deletes `hls/<id>/` prefixes whose `<id>` is not in `AudioClip`. Bounded to 1000/run. |
| Beat | `flush_counters_to_pg` (every 5 min) | `default` | up to 5 min | In Phase 2 (`ECHOFLOW_DUAL_WRITE_COUNTERS=False`) the only writer of `AudioClip.likes/shares/skips` for non-telemetry interactions. |
| Beat | `flush_telemetry_legacy` (every 30 s) | `default` | n/a | Drains the LIST fallback `telemetry:queue`. Only used when `ECHOFLOW_TELEMETRY_STREAM=off`. |

For any user-uploaded clip the frontend **cannot poll for completion**
— there is no `/clips/{id}/` GET endpoint that returns status (only the
router-inherited retrieve on `AudioUploadSerializer`, which DOES return
status — see `AudioUploadSerializer.Meta.read_only_fields = ['id',
'status']`, `backend/app/serializers.py:46`). The frontend CAN poll
`GET /clips/{id}/` while waiting, but in practice the clip is unlikely to
appear in any feed until processing completes (and the user can be
redirected to feed without further UX).

### 1.7 Error model

All DRF endpoints return errors in DRF's standard envelope:

```json
{ "detail": "<message>" }
// or for validation:
{ "field_name": ["error1", "error2"] }
// or for custom validation:
{ "error": "<message>" }
```

The frontend must check both `detail` and per-field keys. The
`sample_frontend` `api()` helper unwraps `data.detail || data.error || 'Request failed'`
(`frontend/sample_frontend/src/api/client.ts:84`), but field-level errors
(such as `{original_file: ["..."]}` from upload) need separate handling.

Specific status codes to handle:

| Status | Frontend action |
| --- | --- |
| 400 | Validation error; surface field-level messages |
| 401 | Try refresh-token rotation once. If that also 401s, clear local auth state and route to `/login`. |
| 403 | Permission denied (e.g., non-author editing a comment, non-recipient deleting a share). UI: toast "Not allowed" and refresh the listing. |
| 404 | Resource missing (deleted clip, nonexistent user). UI: remove from local cache and show empty state. |
| 429 | Throttled. The DRF response includes `Retry-After`. UI: exponential backoff; for `telemetry` and `login` it is hard-capped — queue and retry, do not spam. |
| 202 | Async accepted (clip upload, telemetry, feed-cold). UI: continue normal flow, optionally poll. |
| 204 | No body; successful delete or mark-read. UI: remove from cache. |
| 500 | Server error. UI: toast, retry once after 2 s, then surface error. |

### 1.8 Throttling

`backend/EchoFlow/settings.py:527-538`:

```text
anon:              100/hour
user:             1000/hour
telemetry:          60/min      # log_telemetry (the abuse vector)
upload:             20/hour     # /clips/ (DoS guard)
register:          200/hour     # /auth/register/ (per IP)
register_username:   3/hour     # /auth/register/ (per username)
login:              10/min      # /auth/login/ (credential stuffing)
token_refresh:     120/hour     # /auth/token/refresh/ (per verified user_id)
comment:            60/hour     # /comments/ (spam)
share_send:        100/hour     # /share/{clip_id}/send-share/
share_poll:       1000/hour     # inbox/unread/mark-read (polling)
interaction:        60/min     # toggle-like, register-skip
```

**Do not key rate-limit assumptions on the client IP.** `anon` is 100/hour
per address, and on a mobile network one carrier NAT gateway is thousands of
subscribers. `/auth/token/refresh/` was inheriting exactly that and logged
out entire cells; it is now keyed on the verified subject in the refresh
token. `/auth/register/` is 200/hour per IP plus 3/hour per username.
See `docs/EXPLAIN/auth/04-rate-limiting.md`.

⚠️ `ScopedRateThrottle` allows **everything** when the view declares no
`throttle_scope`. That is a backend concern, not a client one, but it means
"the client was throttled" and "the throttle is not wired" are
indistinguishable from the client side.

`/feed/` and `/suggestions/` are NOT throttled beyond the default `user`
scope (1000/hour) — a chatty client is fine up to ~16 req/min. But
telemetry is the abuse vector the audit flagged, and 60/min is tight
(1 req/sec sustained). The frontend should batch telemetry into one
`log-telemetry` call per ~1–5 s of playback (e.g., a periodic flush
every 3 s), not per-second.

### 1.9 Health, readiness, metrics

`/health/` (liveness, `backend/EchoFlow/health.py:9-17`) and `/ready/`
(readiness, with DB ping, lines 20-41) are unauthenticated JSON
endpoints intended for nginx / k8s probes. The frontend should NOT poll
them. `/metrics/` is the Prometheus scrape target — also not for the
frontend.

The existing `useBackendStatus` hook
(`frontend/sample_frontend/src/hooks/useBackendStatus.ts`) probes
`/profile/me/` with a 3 s timeout to decide "connected vs demo mode".
This works because `/profile/me/` returns 401 for unauthenticated
clients (and 200 for authed) — both indicate the backend is up. This
contract is fine to keep.

---

## 2. Existing frontend — what's there, what's broken

This is an audit of `frontend/sample_frontend/` against the backend
contract in §1. Status per file:

### 2.1 `src/api/client.ts` — API client

**Partially implemented.** Maps are mostly correct but several contracts
are subtly wrong:

- **Wrong method for mark-read.** Uses `PATCH /share/{id}/mark-read/`
  (`client.ts:137`). Backend action is `POST` — see
  `backend/app/views/social.py:92-95` and §1.2. **Status: Broken.**
- **Missing endpoints.** The backend exposes these that the client does
  not call:
  - `POST /auth/logout/` — never called; the frontend just clears
    `sessionStorage` (`stores/auth.tsx:63-67`).
  - `DELETE /comments/{id}/` — wired but only DELETE; PATCH for edit is
    **not wired** anywhere (the spec requires `IsAuthorOrReadOnly`).
  - `PATCH /comments/{id}/` for editing own comments — missing.
  - `DELETE /clips/{id}/` — not wired (clip management is missing; see §3.4).
  - `PATCH /profile/me/update/` — wired but only accepts FormData
    (`client.ts:150`); username-only edits will work, profile-picture
    uploads will work, but no validation on MIME/size.
- **Missing `authAPI.logout`** — see `stores/auth.tsx`.
- **`register` does not call login.** Backend returns a User, not
  tokens. `stores/auth.tsx:52-61` calls `persist(d, d.user)` which
  stores `d.access` / `d.refresh` — but those don't exist on the
  register response. **Status: Broken — registration logs the user in
  but no real tokens are stored.**
- **No `Retry-After` handling for 429s.** The helper treats every
  non-401 non-OK as a generic error.
- **No `errors` shape passthrough for upload 400s.** Field-keyed errors
  from `AudioUploadSerializer` (`{original_file: [...]}`) are flattened
  to `message`. The `Upload.tsx` page does try to read
  `errors?.title?.[0]` and `errors?.original_file?.[0]`
  (`pages/Upload.tsx:71-72`) — that part is wired correctly.

### 2.2 `src/stores/auth.tsx` — Auth context

**Partially implemented.** See §2.1. Specific gaps:

- `register()` (`stores/auth.tsx:52-61`) doesn't call
  `authAPI.login()` after `register()`. Add:
  ```ts
  const d = await authAPI.register(email, username, password);
  const tokens = await authAPI.login(username, password);
  persist(tokens, d);
  ```
  Or restructure so the register endpoint returns tokens (it doesn't
  today; not changing the backend).
- `logout()` (`stores/auth.tsx:63-67`) is local-only. The backend's
  refresh-token blacklist is never invoked. If the user expects
  "sign out everywhere" semantics this leaks until token TTL. **At
  minimum**, call `authAPI.logout()` (new) which `POST`s
  `/auth/logout/` with the stored refresh token.
- `patchUser()` (line 75-79) writes only to local storage and does NOT
  PATCH `/profile/me/update/`. Username changes go through
  `pages/Profile.tsx:60-72` but the local auth state must be refreshed
  via a separate `profileAPI.getMyProfile()` after PATCH.
- `loadUser()` and `loadToken()` (lines 5-15) read sessionStorage but
  there's no hydration of `user` from the backend on hard reload —
  `getMyProfile()` is never called by the auth provider.

### 2.3 `src/stores/player.tsx` — Audio playback

**Partially implemented.**

- Uses `hls.js` for non-Safari browsers and falls back to native
  `application/vnd.apple.mpegurl` for Safari. This is correct.
- **Wrong base for src.** Line 55:
  ```ts
  const fullSrc = src.startsWith('http') ? src : (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000') + src;
  ```
  But `src` from `FeedClipSerializer.hls_playlist_url` is **always** an
  absolute HTTPS URL (the serializer calls
  `media_urls.get_hls_playback_url()` which returns
  `https://<host>:<port>/<bucket>/hls/<id>/master.m3u8`). The
  fallback `http://localhost:8000 + src` is unreachable behind the
  nginx terminator and would corrupt the URL if `src` ever does start
  with a `/` (e.g., during local non-TLS MinIO dev). **Status: Defensive
  but wrong default.**
- **Telemetry fired only on unmount/cleanup** (`stores/player.tsx:87-93`).
  If the user navigates away mid-clip without destroying the player,
  the event fires; if they `play(clip2)` while clip1 is still in
  `active` slot, the previous listener is replaced and the cleanup runs
  first — that works, but ONLY for the `view` action_type. The audit
  expects `log_telemetry` to be called periodically (every 5–10 s)
  during playback, not only at the end. **Status: Missing periodic
  heartbeat telemetry.**
- **No `register-skip` on quick advance.** When the user taps
  skip-forward 10 s repeatedly, the backend has no signal that the
  user is "skipping" vs "scrubbing". The frontend never calls
  `register-skip` at all in the current code. **Status: Missing.**
- **`destroy` doesn't cancel in-flight telemetry.** When the user logs
  out, the in-flight telemetry call will still try to POST and may
  silently 401. Acceptable; just log.
- **No handling of `status: 'processing'` clips.** The player
  happily tries to load `hls_playlist_url=null` when a clip is in
  `processing` (the field is `null` until `process_audio_to_hls`
  finishes — see `backend/app/tasks.py:343-345`). The current
  `loadSource()` (`stores/player.tsx:44-69`) bails with `'No stream
  available'`. **Status: Acceptable but UI doesn't pre-filter; a card
  showing "processing" clips would be confusing.** A user's own
  uploads may briefly appear with `status='processing'` if they poll
  `/profile/{me}/clips/` after upload — the model field is unfiltered
  in `ProfileViewSet.user_clips` (which filters to `status='ready'`,
  good) but a freshly-uploaded clip will simply not appear in the list
  yet.
- **No `audio.onwaiting` debouncing.** Spinner flickers on slow
  networks. Cosmetic.

### 2.4 `src/pages/Upload.tsx` — Audio upload

**Implemented (with caveats).**

- Form fields (`title`, `category`, `original_file`) match
  `AudioUploadSerializer` requirements.
- File-size cap (`100 * 1024 * 1024`) and MIME pre-check (`audio/*`) match
  the serializer (`backend/app/serializers.py:22-35, 49-50`).
- **Duration cap is NOT validated client-side.** The serializer rejects
  files > `MAX_DURATION_SECONDS = 300 s` (5 min) via the `pydub`
  duration probe (`backend/app/serializers.py:107-111`). The frontend
  should warn the user *before* upload (the user can't tell from the
  file size alone — a 30 MB AAC at high bitrate could be 5 min; a 30 MB
  WAV is ~30 s).
- **Tags input is unused.** The user types tags, they render as chips,
  but they are **never sent to the backend** (the backend doesn't
  accept user tags anyway — `AudioUploadSerializer.Meta.fields =
  ['id','title','category','original_file','status']`). **Status:
  Dead UI / no backend consumer.** See §3.4.
- **`stage` states are cosmetic.** `'processing' | 'analyzing' |
  'transcoding'` are never set by the code — only `uploading` and
  `done` / `error` are used. The progress bar is a fake increment
  (`pages/Upload.tsx:53`).
- **No handling of `202 Accepted` + post-upload redirect.** The page
  redirects to feed 1.8 s after the upload response — but does not
  show "your clip is processing; it'll appear in your feed shortly" or
  link to the user's profile.

### 2.5 `src/pages/Feed.tsx` + `src/components/feed/ReelList.tsx` — Feed list

**Partially implemented.**

- `fetchFeed()` (`data/feedAdapter.ts:18-30`) calls
  `feedAPI.getFeed()` and expects `FeedResponse.results`. It does
  **NOT** inspect the `202 Accepted` cold-path response (with
  `retry_after_ms: 1500`) and **NOT** the `degraded: true` fallback
  response shape.
  - The 202 path returns `{results: [], message, retry_after_ms,
    degraded}`. The current code reads `d.results` and gets `[]`,
    then sets `clips=[]`, `hasMore=true` — and the InfiniteScroll
    sentinel immediately fires `loadMore`, hammering `/feed/` at
    ~once per second until either Redis comes back or the user kills
    the tab. **Status: Broken (polling storm).** Correct behavior is
    `setTimeout(retry, retry_after_ms)` and not retrying until
    `clips.length > 0` OR a max-retry budget is hit.
  - The `degraded: true` (Redis-down) path returns a real results
    array; the frontend should optionally show a small "showing
    trending — personalization temporarily unavailable" badge.
- **Infinite scroll fires `loadMore` even when `clips` is empty.**
  `ReelList.tsx:26-33` observes the second-to-last item; if
  `clips.length === 0` there's no sentinel, but the IntersectionObserver
  is never recreated so a 0 → 1 → 0 → 1 oscillation would skip loadMore.
  Edge case.
- **Auto-advance on completion** (`ReelList.tsx:36-47`) advances 1 s
  after `progress >= 0.99`. The backend has no concept of "completion"
  beyond `completion_rate`, which the frontend never sends back to
  the server unless `register-skip` is called. **Status: Missing
  completion telemetry** — when the clip plays to the end with no
  skip, the backend never knows. Either:
  - call `logTelemetry({action_type: 'view', watch_time_ms: duration_ms})`
    at completion, or
  - call `registerSkip` with `listen_duration_ms ≈ clip.duration_ms`
    (semantically wrong — this would increment `skips`).
  The correct signal is the first one (a `view` telemetry at completion).
- **Auto-play on view** (`ReelList.tsx:49-65`) plays every clip that
  intersects ≥ 60%. Combined with auto-advance this means the user
  effectively gets a continuous autoplay feed. No backend interaction
  on autoplay start — see §3.5.
- **`clips` state accumulates forever.** `setClips(p => [...p, ...fresh])`
  (`pages/Feed.tsx:28`) is unbounded. The user can scroll forever; the
  backend has no `/feed/?cursor=` (it's a Redis lpop, not a SQL
  cursor). Once the Redis queue empties, the 202/retry cycle kicks in
  again. **Status: Works but UX-wise confusing** — `hasMore=true` is
  a constant string in `feedAdapter.ts:25`.

### 2.6 `src/pages/Explore.tsx` — Suggestions / categories

**Partially implemented.**

- Calls `feedAPI.getSuggestions(category)` for "music / science / funny /
  instrumental" but ignores the **paginated** response shape
  (`{next, previous, results}`). It treats the response as a flat array
  and falls back to `(d as AudioClip[]) || []` in `feedAdapter.ts:39`.
- `?category` is hardcoded; the user's free text in the search input
  is **not used** (`pages/Explore.tsx:22-24`).
- **No infinite scroll.** Suggestions are loaded once on hub select.
- **VIBE_TAGS / DISCOVERY_HUBS** are demo constants and don't map to
  backend categories — see §3.7.

### 2.7 `src/pages/Profile.tsx` — Profile view

**Partially implemented.**

- Own profile (`userId == me`) calls `profileAPI.getProfile` (public
  serializer, missing `liked_clips`). **Bug:** `pages/Profile.tsx:42`
  uses `profileAPI.getProfile(Number(targetId))` even when
  `targetId === au?.id`. Should use `profileAPI.getMyProfile()` for the
  own profile to get `liked_clips`. **Status: Broken — own-profile tab
  "liked" is always empty.**
- Public profile doesn't call `clipsAPI.getUserClips` for the demo
  branch — see `pages/Profile.tsx:36-46`. Acceptable (demo mode).
- Username edit calls `profileAPI.updateProfile(fd)` with
  `fd.append('username', newName)`. Works, but doesn't refresh the
  stored user via `patchUser` until after the API call — race-safe
  enough.
- Profile picture upload is not wired in the UI (the Avatar component
  shows the existing picture if any).
- No `getFollowersList` / `getFollowingList` — backend has no such
  endpoint; not a gap.

### 2.8 `src/pages/Inbox.tsx` — Inbox

**Implemented with one broken method.**

- `markRead` uses PATCH (`pages/Inbox.tsx:31`) but backend is POST. Will
  return 405. **Status: Broken.**
- Otherwise: inbox list, optimistic mark-read, delete, click-to-preview
  via `ReelCard`, tabs (messages / activity — activity is demo data,
  no backend). Acceptable.
- The 30 s polling on `unread-count` (`AppShell.tsx:21-27`) fits within
  the `share_poll = 1000/hour` budget.

### 2.9 `src/components/comments/CommentSheet.tsx` — Comments

**Partially implemented.**

- Posts new top-level comments. No reply (no `parent`).
- No edit / delete. The backend supports PATCH and DELETE for author;
  UI doesn't expose it. **Status: Missing.**
- The optimistic `Comment` object in the demo branch (`CommentSheet.tsx:38-41`)
  fabricates `id: 'new'` — that's a string, not a UUID, so if the user
  tries to delete the optimistic comment it will 404. Acceptable
  because demo-only.
- No pagination (`?cursor=`). Backend cursor-paginates; UI loads only
  page 1.

### 2.10 `src/components/sharing/ShareModal.tsx` — Share modal

**Implemented.**

- Debounced `find-user` (500 ms) is correct.
- Sends via `sendShare(clipId, receiverId)`. Correct.
- **"Copy link" generates `window.location.origin + '/clip/' + clip.id`.**
  This is a 404 link unless the frontend has a `/clip/:id` route. The
  current `AppRouter` does NOT register `/clip/:id`. **Status: Broken
  — copied link is non-functional.**

### 2.11 `src/components/feed/OnboardingModal.tsx` — Cold-start tag picker

**Implemented.**

- Calls `tagsAPI.initialize(selTags)` with the selected tags.
- One concern: the modal fires only for `ef_new_user === '1'`
  (`AppShell.tsx:30-35`), which is set by `register()`. But the
  register flow is broken (no tokens), so the new-user flag is never
  set and the modal never appears. **Status: Latently broken.**

### 2.12 `src/components/feed/MiniPlayer.tsx` — Persistent mini player

**Implemented.**

- No issues against the backend contract.

### 2.13 `src/components/navigation/BottomNav.tsx` — Bottom navigation

**Implemented.**

- Routes via `window.location.href = '/' + p` (`AppShell.tsx:37`). This
  is a hard navigation, not `react-router-dom` Link navigation —
  every tab change is a full page reload. The router
  (`app/router.tsx`) has BrowserRouter wired but `navTo` ignores it.
  **Status: Functional but inefficient.** All state is lost on each
  nav.

### 2.14 `src/data/feedAdapter.ts` — Feed/suggestion adapter

**Partially implemented.**

- Switches to demo mode on first API failure. After switching, every
  subsequent call uses the demo branch even if the backend comes back.
  The `setBackendStatus(true)` path is never called by the adapter —
  only `BackendWatcher` in `router.tsx:69-74` toggles it back. The
  watcher only fires once on mount. **Status: Once a tab falls back to
  demo mode, it stays demo until full reload.**
- Demo branch uses `DEMO_ME`, `DEMO_CLIPS`, etc., which don't reflect
  actual API responses.

---

## 3. Required frontend features (per capability)

This section lists every backend capability the frontend must consume
and the corresponding UI/UX requirement. Each item maps back to §1.

### 3.1 Authentication & onboarding

#### FR-AUTH-1 — Registration form
- **Required inputs:** `email` (required, must be unique server-side),
  `username` (required, inherits AbstractUser rules: 150-char max,
  alphanumeric + `@.+-_`), `password` (required, subject to Django's
  4 validators; UI must show password-strength feedback for the
  `MinimumLengthValidator` (≥ 8) and the `CommonPasswordValidator`).
- **Flow:** submit → call `POST /auth/register/` → if 201, immediately
  call `POST /auth/login/` to obtain tokens → persist `{access,
  refresh}` → set `ef_new_user=1` → navigate to `/explore` (so the
  user sees the category picker).
- **Errors to render:** 400 field errors. Specifically, `email`
  duplicate returns `{"email": ["..."]}` (RegisterSerializer
  UniqueValidator). 429 (`register` 200/hour per IP, or `register_username` 3/hour per username).
- **Implementation status:** **Partially implemented** —
  `stores/auth.tsx:52-61` is broken (doesn't login).

#### FR-AUTH-2 — Login form
- **Required inputs:** `username` (NOT email — the login endpoint
  uses SimpleJWT's default `USERNAME_FIELD`), `password`.
- **Flow:** submit → `POST /auth/login/` → persist tokens.
- **Errors to render:** 401 → "Invalid username or password". 429 →
  cooldown timer (10/min/IP). 0 (network) → "Cannot connect to
  backend".
- **Implementation status:** **Implemented.**
- **Gap:** no client-side rate limiting on the login button.

#### FR-AUTH-3 — Session refresh
- **Required behavior:** when any API returns 401, attempt
  `POST /auth/token/refresh/` once with the stored refresh token.
  If success, retry the original request with the NEW access token;
  store the NEW refresh token (the old one is blacklisted). If
  refresh fails, clear tokens and dispatch `ef_session_expired`.
- **Implementation status:** **Implemented.** Verified at
  `client.ts:50-78`. The 401 retry chain correctly updates the
  stored refresh token.

#### FR-AUTH-4 — Logout
- **Required behavior:** call `POST /auth/logout/` with the stored
  refresh token (body `{refresh: ...}`), then clear local storage
  regardless of the response (a network error during logout should
  not strand the user). Optionally invalidate the access token by
  simply discarding it (15-min TTL).
- **Implementation status:** **Missing.** See `stores/auth.tsx:63-67`.

#### FR-AUTH-5 — Onboarding (cold-start tag picker)
- **Required behavior:** modal shown only after register/login when
  the user has zero interactions. User picks 1+ tags → submit →
  `POST /tags/initialize/` body `{selected_tags: [...]}`. On 200,
  close modal and navigate to `/feed`. On 400
  ("Not enough data to build baseline."), show a banner explaining
  the catalog needs to be seeded (this is an admin/operator concern;
  the user can't fix it).
- **Edge case:** re-picking after the initial onboarding **resets**
  the long-term vector. UI should warn if the user has prior
  interactions.
- **Implementation status:** **Partially implemented.**
  (`OnboardingModal.tsx`). Trigger flag is set in
  `stores/auth.tsx:58` but the registration flow is broken, so the
  modal never appears.

### 3.2 Feed

#### FR-FEED-1 — Feed list
- **Endpoint:** `GET /feed/`.
- **Required handling:**
  - **200 normal:** render results, show queue_health only if useful
    (probably not — it's an internal queue length).
  - **202 cold:** show "Preparing your feed…" placeholder and retry
    after `retry_after_ms` (default 1500). Cap retries at 5; after
    that, show the empty state.
  - **200 degraded:** render results but show a small banner
    "Showing trending — personalization temporarily unavailable".
- **Pagination/infinite scroll:** the backend has no cursor on
  `/feed/`. The frontend should treat each request as a fresh pop of
  up to 10 from the per-user Redis queue. After the user has scrolled
  through `clips.length >= 30` clips (3 pages) without a refill
  firing (no new clips arriving), show "All caught up".
- **Auto-play:** play the most-visible clip; auto-advance 1 s after
  `progress >= 0.99`.
- **Implementation status:** **Partially implemented.** The 202/cold
  retry logic is missing (current code triggers an immediate poll
  storm).

#### FR-FEED-2 — Feed card (`AudioClip` view)
- **Display fields:** `title`, `creator_name`, `category`, `hls_playlist_url`
  (use verbatim — already absolute HTTPS), `likes`, `shares`,
  `comment_count`, `is_liked`. Note: `tags` is **not** in
  `FeedClipSerializer` — the sample frontend displays `clip.tags`
  but the backend never sends it. **Status: Frontend behavior
  unsupported by backend.** Either drop the tags UI or fetch full
  clip detail elsewhere (no such endpoint exists; would need a new
  serializer field).
- **Action buttons:**
  - **Like** → `POST /interactions/{id}/toggle-like/`. Optimistic
    toggle. On 200, set `is_liked` to `data.status === 'liked'`. On
    429, revert and toast.
  - **Comment** → open `CommentSheet` (see FR-COMMENT-1).
  - **Share** → open `ShareModal` (see FR-SHARE-1).
  - **Creator follow** → `POST /follow/{user_id}/toggle-follow/`. On
    200/201, update label. Self-follow is blocked server-side; UI
    hides the button for own clips (already does, line 191).
- **Implementation status:** **Implemented** for the buttons.
  Tags UI is misleading.

#### FR-FEED-3 — Mini-player
- Persists across page navigations (or at least doesn't unmount).
  Already implemented.

### 3.3 Explore / suggestions

#### FR-EXPLORE-1 — Category-scoped suggestions
- **Endpoint:** `GET /suggestions/?category=<X>`.
- **Category list:** the backend stores `category` as a free-form
  CharField (no enum), but in practice the catalog uses
  `instrumental / funny / news / science / music` (see
  `frontend/sample_frontend/src/data/clips.ts:12` and the README).
  The frontend should keep this list as the curated picker; the
  backend will simply return an empty list if the category has no
  ready clips. **Status: Backend capability with no constraint — UI
  may add categories freely.**
- **Pagination:** cursor (`FeedCursorPagination`, page_size=10).
  Frontend must follow `next`/`previous` URLs.
- **Implementation status:** **Partially implemented.** Ignores
  pagination envelope.

#### FR-EXPLORE-2 — Search by free text
- **Backend has no search endpoint.** The search input in
  `pages/Explore.tsx:21,61-69` is wired to local state and never
  queries anything. The only backend capability for "search by tag"
  is `POST /tags/initialize/` (which initializes vectors, not
  filters). The current Explore-page `query` field is a **frontend
  behavior unsupported by backend** — must be either removed or
  replaced with category filtering.
- **Recommendation:** remove the text input, or wire it to
  `?category=<query>` (limited but functional).

### 3.4 Clip upload & management

#### FR-UPLOAD-1 — Upload flow
- **Endpoint:** `POST /clips/` (multipart form-data).
- **Form fields:** `original_file` (required, audio, ≤ 100 MB,
  ≤ 300 s), `title` (required, ≤ 255), `category` (required,
  ≤ 50).
- **Client-side pre-validation (to save a round-trip):**
  - File extension in the allowlist
    (`.mp3 .wav .ogg .flac .m4a .aac .webm .opus`).
  - File size ≤ 100 MB.
  - **Duration ≤ 300 s** (use `<audio>` element `loadedmetadata`
    event; not currently done — would prevent the 400 from the
    server-side `pydub` probe).
  - MIME sniff (skip — backend does it).
- **Response:** `202 Accepted` with `{clip_id, status:
  "processing"}`. UI shows "Uploaded — processing" screen and
  redirects to feed/profile.
- **Implementation status:** **Implemented** but without duration
  pre-check. The tags input is dead UI.

#### FR-UPLOAD-2 — Edit clip metadata
- **Endpoint:** `PATCH /clips/{id}/`.
- **Mutable fields:** `title`, `category`. **`original_file` is
  silently stripped** server-side (`backend/app/views/content.py:45-60`);
  any attempt to re-upload audio via PATCH is a no-op.
- **Implementation status:** **Missing.** No UI for editing one's
  own clips.

#### FR-UPLOAD-3 — Delete clip
- **Endpoint:** `DELETE /clips/{id}/`.
- **Side effects:** post_delete signal removes `original_file` and
  the `hls/<id>/` S3 prefix (`backend/app/signals.py:29-95`).
  Cascade-deletes `Comment` and `ShareEvent` rows. `UserInteraction`
  rows are also cascade-deleted by default (the FK is declared
  without `on_delete`, so Django uses CASCADE — verify before
  relying on it).
- **Implementation status:** **Missing.** No UI for deleting
  uploads.

#### FR-UPLOAD-4 — Tag input on upload
- **Backend does not accept tags** from the upload endpoint. The
  `AudioUploadSerializer.Meta.fields = ['id', 'title', 'category',
  'original_file', 'status']` — there is no `tags` field. Tags on a
  clip are produced server-side by `KeyBERT` during HLS processing
  (`backend/app/tasks.py:269-276`).
- **Frontend behavior unsupported by backend:** the tag input in
  `pages/Upload.tsx:77-82, 184-195` accepts input but never submits
  it. **Action required:** remove the tag UI or wire it to
  `category` (i.e., tag → category mapping).

### 3.5 Playback telemetry

#### FR-TEL-1 — Periodic view telemetry
- **Endpoint:** `POST /interactions/{id}/log-telemetry/`.
- **Body:** `{action_type: "view", watch_time_ms: <int>}`.
- **When to send:**
  - Every ~5–10 s during playback (heartbeat).
  - On `pause` (final value).
  - On `ended` (final value = `clip.duration_ms`).
- **Throttling:** `60/min/user`. Cap client at 1 call / 5 s. If 429
  is received, buffer the next event but drop the oldest. Never
  spam.
- **Failure handling:** telemetry failures are NON-FATAL — log and
  drop. The `flush_telemetry_stream` consumer is best-effort.
- **Implementation status:** **Partially implemented.** Only fires
  on player unmount (`stores/player.tsx:87-93`); no heartbeat.

#### FR-TEL-2 — Skip telemetry
- **Endpoint:** `POST /interactions/{id}/register-skip/`.
- **Body:** `{listen_duration_ms, reel_position_ms, reel_id}`.
- **When to send:**
  - When the user advances past the clip's natural end (auto-advance
    at `progress >= 0.99`): send `listen_duration_ms ≈
    clip.duration_ms`, `reel_position_ms = clip.duration_ms`.
  - When the user taps skip-forward to leave the clip mid-play:
    send `listen_duration_ms ≈ current_time * 1000`,
    `reel_position_ms = clip.duration_ms`.
- **Note:** the backend counts this as a `skip` (was previously
  `view` — fixed in audit pass 3). The endpoint name is
  `register-skip`; the user-facing label can be "skip" or "watched".
- **Implementation status:** **Missing.**

### 3.6 Comments

#### FR-COMMENT-1 — List comments
- **Endpoint:** `GET /comments/?clip=<id>&parent=<id>`. Filter is
  required: omit `parent` to get top-level, set `parent=<id>` to get
  replies. Pagination is cursor-based.
- **Display fields:** `author_username`, `text`, `reply_count`,
  `created_at`. The serializer does NOT return `author_id`,
  `author_profile_picture`, or any followable link — the frontend
  must either derive a profile link from `author_username` (best
  effort: `/profile?username=<x>` — no such route exists today) or
  not render a clickable profile. **Backend capability with no
  frontend consumer:** the author profile link.
- **Implementation status:** **Partially implemented.** Loads page 1
  only; no reply threads; no profile links.

#### FR-COMMENT-2 — Post top-level comment
- **Endpoint:** `POST /comments/`. Body: `{clip: <uuid>, text:
  <str>}`.
- **Validation:** server strips control chars, rejects NUL bytes,
  caps at 500. UI should mirror these.
- **Side effect:** bumps `AudioClip.comment_count` via `F()`
  (`backend/app/models.py:121-126`).
- **Implementation status:** **Implemented.**

#### FR-COMMENT-3 — Reply to comment
- **Endpoint:** `POST /comments/`. Body: `{clip: <uuid>, text:
  <str>, parent: <comment_uuid>}`.
- **No depth limit** server-side. UI may cap displayed depth at 2
  or 3.
- **Replies do NOT increment `comment_count`** — only top-level do.
- **Implementation status:** **Missing.**

#### FR-COMMENT-4 — Edit own comment
- **Endpoint:** `PATCH /comments/{id}/`. Body: `{text: <str>}`.
- **Permission:** `IsAuthorOrReadOnly` (`backend/app/views/comments.py:27-37`)
  → 403 if not author. `get_queryset()` also filters to author's
  rows, so a non-author PATCH returns 404 (the spec says "don't
  leak existence").
- **Implementation status:** **Missing.**

#### FR-COMMENT-5 — Delete own comment
- **Endpoint:** `DELETE /comments/{id}/`.
- **Side effect:** decrements `AudioClip.comment_count` via `F()` in
  `Comment.delete()` (`backend/app/models.py:128-131`) only for
  top-level comments.
- **Implementation status:** **API call is wired in
  `client.ts:127` but no UI invokes it.** Status: missing.

### 3.7 Sharing

#### FR-SHARE-1 — Send a share
- **Endpoint:** `POST /share/{clip_id}/send-share/`. Body:
  `{receiver_id: <int>}`.
- **Pre-step:** resolve the receiver via `GET
  /share/find-user/?username=<x>` (debounced).
- **Side effects:** creates a `UserInteraction(type='share')` row
  (counter increment via `F()`), creates a `ShareEvent` row in the
  recipient's inbox, invalidates sender's `user_vectors` cache.
- **Implementation status:** **Implemented.**

#### FR-SHARE-2 — Inbox
- **Endpoint:** `GET /share/inbox/`. Returns a plain list (NOT a
  paginated envelope).
- **Display:** for each `ShareEvent`, render `sender_name`, the
  embedded `clip` (FeedClipSerializer), `clip_hls_url` (absolute
  HTTPS, fresh per-request), `created_at`, `is_read` badge.
- **Implementation status:** **Implemented.**

#### FR-SHARE-3 — Unread count badge
- **Endpoint:** `GET /share/unread-count/`. Returns
  `{unread: <int>}`.
- **Polling:** every 30 s is appropriate (`share_poll = 1000/hour`
  budget allows ~33/min). Drive from the global `AppShell` so the
  badge is up-to-date even when the inbox page isn't mounted.
- **Implementation status:** **Implemented.**

#### FR-SHARE-4 — Mark read
- **Endpoint:** `POST /share/{id}/mark-read/` (NOT PATCH — see §2.1).
- **Implementation status:** **Broken — wrong method used.**
  Fix: change `client.ts:137` to `method: 'POST'`.

#### FR-SHARE-5 — Delete share
- **Endpoint:** `DELETE /share/{id}/share-delete/`. Filter:
  `receiver=request.user` — only the recipient can delete.
- **Implementation status:** **Implemented** (`client.ts:138` calls
  correctly).

#### FR-SHARE-6 — Copy share link
- The current implementation generates
  `window.location.origin + '/clip/' + clip.id`. There is no
  `/clip/:id` route. **Action required:** either add the route
  (which would need a backend endpoint that takes a clip UUID and
  returns a deep-linkable clip view) or change the copy to
  `window.location.origin + '/profile/<creator_id>/?clip=<id>'` and
  teach the profile page to deep-link to a specific clip. **Easiest
  fix:** copy the API's HLS URL instead (`clip.hls_playlist_url`) so
  the recipient can play the audio directly in their browser.

### 3.8 Follows

#### FR-FOLLOW-1 — Toggle follow
- **Endpoint:** `POST /follow/{user_id}/toggle-follow/`.
- **Response:** 200 with `{status: "unfollowed"}` or 201 with
  `{status: "followed"}`. Status code is meaningful — the frontend
  should use the body `status` rather than the HTTP code for the
  label.
- **Implementation status:** **Implemented.**

#### FR-FOLLOW-2 — Followers / following lists
- **Backend has no list endpoint.** The model has the M2M but no
  serializer/endpoint to enumerate. The profile page shows counts
  but no drill-down. **Status: Backend capability with no
  frontend consumer (and no backend endpoint).**

### 3.9 Profile

#### FR-PROFILE-1 — Get own profile
- **Endpoint:** `GET /profile/me/`. Returns `OwnProfileSerializer`
  including `liked_clips` (up to 50) and `email` (NOT exposed by
  `PublicProfileSerializer`).
- **Implementation status:** **Partially implemented.**
  `pages/Profile.tsx:42` calls `getProfile(targetId)` (public) even
  for own profile — should call `getMyProfile()` so `liked_clips`
  is populated.

#### FR-PROFILE-2 — Get public profile
- **Endpoint:** `GET /profile/{id}/`. Returns
  `PublicProfileSerializer` (no email, no liked_clips).
- **Implementation status:** **Implemented.**

#### FR-PROFILE-3 — Update own profile
- **Endpoint:** `PATCH /profile/me/update/` (multipart form).
  Fields: `username` (validated unique), `profile_picture` (file —
  no server-side size/MIME validation).
- **Client-side pre-validation:** avatar image ≤ e.g. 5 MB,
  `image/*` MIME. Server has no guard.
- **Implementation status:** **Implemented** for username; not for
  avatar upload UI.

#### FR-PROFILE-4 — List a user's clips
- **Endpoint:** `GET /profile/{id}/clips/`. Cursor paginated,
  `status='ready'` filter applied server-side.
- **Implementation status:** **Implemented.**

#### FR-PROFILE-5 — Show own "liked" tab
- **Implementation status:** **Broken** (see FR-PROFILE-1). After
  fixing the call to `getMyProfile()`, the `liked_clips` field is
  available as `FeedClipSerializer[]`.

### 3.10 Settings

#### FR-SETTINGS-1 — Logout
- See FR-AUTH-4.

#### FR-SETTINGS-2 — Privacy / notifications / language / help / about
- **Backend has no endpoints for these.** The Settings page
  (`pages/Settings.tsx`) has clickable rows that don't navigate
  anywhere (`action: () => {}`). **Status: Frontend behavior
  unsupported by backend.** Either remove the rows or wire them
  to non-functional placeholder pages.

---

## 4. Operational requirements

### 4.1 Token storage

- The frontend must store `access` and `refresh` tokens. The current
  code uses `sessionStorage` (per-tab, cleared on tab close). This is
  acceptable for a PWA, but for a longer-lived install consider
  IndexedDB with a sliding expiration (15-min for access, 7-day for
  refresh). SessionStorage is fine for v1.
- **Never** store tokens in `localStorage` shared across origins.
- **Never** send tokens to any origin other than the configured
  `VITE_API_BASE_URL`.

### 4.2 Refresh rotation

- The backend rotates refresh tokens on every `POST /auth/token/refresh/`
  call (`backend/EchoFlow/settings.py:546-553`). The frontend MUST
  replace its stored refresh token on every successful refresh. The
  current code does so (`client.ts:61`). Confirmed.

### 4.3 401 handling

- The frontend's 401 retry logic is correct
  (`client.ts:50-78`). Two improvements:
  - **Concurrent request storms:** if 10 in-flight requests all
    401 simultaneously, all 10 will fire `token/refresh/` in
    parallel, and 9 will fail (the first refresh blacklists the
    second's old refresh token). Mitigation: serialize refresh
    attempts — maintain a single in-flight refresh promise that
    other 401s await. The current code does not do this. **Status:
    Partially implemented — single-tab is fine; multi-tab may
    see occasional spurious 401s.**

### 4.4 Throttling-aware UX

- `telemetry = 60/min`. If the client fires more often than 1/sec,
  it will hit 429. The frontend should:
  - Batch telemetry into ≤ 1 call / 5 s.
  - On 429, schedule the next attempt at the response's `Retry-After`
    (or 30 s, whichever is greater).
  - Do NOT show a user-facing error for telemetry 429s.
- `share_send = 100/hour`. If a user is sending 1 share / 30 s, they
  will hit 429 after ~50 minutes. Realistically unproblematic.
- `register = 200/hour` per IP, `register_username = 3/hour`, `login = 10/min`.
  Show explicit cooldown UI.

### 4.5 Cache invalidation

The frontend doesn't talk to the backend's Redis cache directly, but
the backend invalidates the user's `user_vectors:{user_id}` cache on
every like, skip, share, and telemetry flush
(`backend/app/services/interactions.py:158-162, 192, 249, 269` and
`backend/app/tasks.py:762-771`). The frontend does not need to do
anything — but it should be aware that a `/suggestions/` request made
within ~15 min of a state change may still serve pre-state-change
rankings if no telemetry has flushed yet. This is intentional
performance behavior.

### 4.6 HLS Playback Token (`ef_hls_token`)

The `hls/` object storage prefix is **token-gated** — it is not public-read.
All HLS playback requires a valid short-lived HMAC credential. There are
**two transports** for the same token: a cookie for browsers, a request
header for native players.

**Web (cookie):**

1. **Before playing any clip**, call `POST /media/playback-token/<clip_id>/` (POST — a GET would be CSRF-able, prefetchable and cacheable)
   with `Authorization: Bearer <access>` and `credentials: 'include'`.
2. The backend sets an `HttpOnly` cookie `ef_hls_token` via `Set-Cookie`.
   The frontend **cannot read this cookie** and must not try — it is
   attached automatically by the browser on all `/hls/*` requests.
3. **Read nothing from the response body.** It is `{"status": "ok"}`.

**Native (header):**

1. Call the same endpoint with an extra `X-EchoFlow-Client: native` header.
2. The response is `{"status": "ok", "token": "<b64url-payload>.<b64url-hmac>"}`.
   **Read `token` from the body.**
3. Attach it to every media request as `X-EchoFlow-Media-Token`, via the
   player's per-source headers. expo-audio applies those to the manifest
   *and* every segment.

**Why native needs a second transport:** `AVPlayer` (iOS) does not read
`NSHTTPCookieStorage`, and ExoPlayer's `DefaultHttpDataSource` (Android)
sends no `Cookie` header — neither shares state with the app's HTTP client.
The cookie is also `HttpOnly` (the app cannot read it back) and `Secure`
(dropped outright over plaintext-HTTP dev). A native client therefore
cannot obtain *or* present the cookie.

The body token is **opt-in**: without the `X-EchoFlow-Client: native` header
the body stays `{"status": "ok"}`, because `HttpOnly` exists to stop script
from reading a bearer credential. The cookie is set in **both** cases, so
this is additive and the web path is unchanged.

**Precedence at the edge is cookie-first.** A page's script cannot read the
`HttpOnly` cookie but can set an arbitrary header, so the header is only
consulted when no token is extractable from the cookie.

**Common to both:**

4. **Error handling:** on 401/403/404, or a network error, do NOT attempt
   playback — show "Playback unavailable". **409** means the clip's media is
   still processing: show a spinner on the artwork and retry in ~5s. 403 also
   covers a moderation rejection.
5. **Scope:** the token is per-clip (`hls/<clip_id>/`). Switching clips
   requires a new token.
6. **TTL:** `MEDIA_TOKEN_TTL_SECONDS` (default 600s). Cache per clip and
   refresh with ~120s of headroom; prefetch the next clip in the queue.

**Why not signed URLs?**
HLS uses relative references between master playlist → variant playlists
→ segments. RFC 3986 §5.2.2 strips query strings during relative
resolution, breaking signed URLs — the manifest returns 200 and every
segment it names returns 403. A single signed URL cannot authorize a stream
made of dozens of objects. The token is issued per *path prefix* instead,
which survives relative-reference resolution.

**Implementation reference:**
- `backend/app/views/media.py` — `_token_response_body()` (the opt-in and why)
- `backend/app/throttling.py`, `backend/app/urls.py` — refresh keying
- `workers/hls-token-worker/src/token.ts` — `extractTokenFromRequest()` (precedence)
- Design: `docs/EXPLAIN/decisions/2026-09-28-native-media-auth-and-cgnat-throttling.md`
- `docs/EXPLAIN/storage/04-hls-token-protection.md` — full design
- `docs/mobile-rebuild-plan.md` §10 — the mobile playback sequence

### 4.7 Media URL handling

- `hls_playlist_url` from any `FeedClipSerializer` is an absolute
  HTTPS URL. **Use it verbatim.**
- `profile_picture` from any User serializer is a relative
  storage key (`avatars/<filename>`). To get a playable URL the
  frontend would have to either:
  - Resolve via `default_storage.url()` server-side (the backend
    does NOT do this for User — only for AudioClip.hls via
    `media_urls.get_hls_playback_url`). The current frontend
    prefixes the API base (`components/common/atoms.tsx:33-34`):
    `src.startsWith('http') ? src : apiBase + src`. This is
    **wrong** for production: the API base is `https://<host>` (no
    port) but the storage is on `https://<host>:9443/<bucket>/...`.
    **Action required:** backend should expose a signed/profile URL
    on the User serializer, OR the frontend should always assume
    `profile_picture` is already an absolute URL (currently false
    on dev where `MEDIA_ROOT` is local).

### 4.8 Polling cadences

| Source | Endpoint | Polling cadence | Notes |
| --- | --- | --- | --- |
| Unread badge | `GET /share/unread-count/` | 30 s | Within `share_poll` budget |
| Feed cold retry | `GET /feed/` | `retry_after_ms` (1500 ms default) | Per-server hint |
| Clip status (post-upload) | `GET /clips/{id}/` | not needed | clip won't appear in feed until ready; user can navigate away |

### 4.9 Health, version, errors

- The frontend should surface a "Backend not reachable" banner when
  `GET /profile/me/` (or any authed call) returns 0 / network error.
  The current `NetworkBanner` (`components/common/NetworkBanner.tsx`)
  listens to `online`/`offline` events but doesn't actually check
  the backend. The `useBackendStatus` hook checks once at mount.
  Improvement: keep the `useBackendStatus` check on a slow timer
  (every 30 s) so the banner recovers after a transient outage.

---

## 5. Data relationships the frontend must respect

| Relationship | Backend model | Frontend implications |
| --- | --- | --- |
| User 1—N AudioClip | `AudioClip.creator FK User` | "My uploads" is `clips.filter(creator=me)`. The profile's clips endpoint already filters server-side. |
| User N—N User | `User.following M2M` | Symmetric=False. Cannot see who follows whom without a follow-list endpoint (doesn't exist). |
| User 1—N Comment | `Comment.author FK User` | Author is identifiable only by `username` in `CommentSerializer` — no `author_id`. |
| AudioClip 1—N Comment | `Comment.clip FK AudioClip` | Deleting a clip cascade-deletes its comments (visible to user as comments disappearing). |
| Comment N—1 Comment | `Comment.parent FK self` | Replies don't bump `comment_count` (`models.py:121-126`). UI must render "N replies" without reflecting in the clip's count. |
| User N—N Clip (via UserInteraction) | `UserInteraction.unique_together=(user,clip,type)` | One like per (user,clip); toggling is a state change on `is_active`, not a row create/delete. |
| User 1—N ShareEvent (sender) | `ShareEvent.sender FK` | "Sent" history is not exposed. |
| User 1—N ShareEvent (receiver) | `ShareEvent.receiver FK` | `GET /share/inbox/` returns only receiver=me rows. |

---

## 6. State machines / transitions the frontend must render

### 6.1 Clip lifecycle

```
upload POST → status='processing'
            ↓ (process_audio_to_hls succeeds)
            status='ready', hls_playlist_url set
            ↓
        feed / profile / suggestions / liked_clips
            ↓ (any user-initiated DELETE /clips/{id}/)
        row + files removed (signals.py)
            ↓
        clip disappears from all lists

            on Celery error / ffmpeg crash:
            status='failed' → never appears in lists; user-uploaded
            failed clip is invisible (no UI for it).
```

The frontend never sees a `failed` clip in normal flow. The
`status='processing'` clip is invisible in lists
(`/profile/{id}/clips/` filters ready, `/feed/` is fed only with
ready clips, `/suggestions/` filters ready). So the only clip-status
the frontend needs to render is `ready`. **Action required:**
- After upload, **do not** navigate to `/profile/<me>/clips/` and
  expect to see the just-uploaded clip immediately. It will appear
  in ~5–60 s once processing finishes.

### 6.2 Like state machine

```
state: not-liked (no UserInteraction row)
   POST toggle-like → UserInteraction created, is_active=True
   state: liked (counter +1)

   POST toggle-like → is_active toggled to False
   state: not-liked (counter -1)

   POST toggle-like → is_active toggled to True
   state: liked (counter +1)

   (idempotent: POST twice in same state does NOT re-toggle)
```

Frontend optimistically toggles; on 200 from the server, re-anchor to
the server's reported state via `data.status`.

### 6.3 Share state machine

```
sender side:
   POST /share/{clip_id}/send-share/ {receiver_id}
      ↓
   ShareEvent row created (receiver=target, sender=me)
   UserInteraction(type='share') row created for me (counter +1)
      ↓
   (no UI feedback beyond toast)

receiver side:
   ShareEvent(is_read=False) appears in /share/inbox/
      ↓ (user opens inbox item)
   POST /share/{id}/mark-read/
      ↓
   is_read=True; unread badge -1
```

### 6.4 Follow state machine

```
state: not-following
   POST /follow/{user_id}/toggle-follow/
   → 201 Created {status: "followed"}
   state: following

   POST /follow/{user_id}/toggle-follow/
   → 200 OK {status: "unfollowed"}
   state: not-following

self-follow attempt:
   POST /follow/{me}/toggle-follow/
   → 400 Bad Request {error: "You cannot follow yourself."}
```

### 6.5 Auth state machine

```
state: anonymous
   POST /auth/register/ → state: anonymous (no auto-login)
   POST /auth/login/    → state: authenticated {access, refresh}

state: authenticated, access valid
   any API call with Bearer → success

state: authenticated, access expired (15 min)
   any API call → 401
      ↓ (auto-handled by client.ts:50-78)
   POST /auth/token/refresh/
      ↓ on 200
   new access + new refresh stored; original request retried
      ↓ on 401
   clearTokens + dispatch ef_session_expired
   → state: anonymous

state: authenticated, refresh expired (7 days)
   POST /auth/token/refresh/ → 401
   → state: anonymous

logout:
   POST /auth/logout/ {refresh} (best-effort)
   clearTokens → state: anonymous
```

---

## 7. Existing frontend behaviors to remove

These exist in the current code but the backend doesn't support them:

| File:line | Behavior | Action |
| --- | --- | --- |
| `pages/Upload.tsx:77-82, 184-195` | Tag chips input | Remove. The backend ignores user-supplied tags on upload. |
| `pages/Upload.tsx:10, 198-200, 213-217` | `stage` states `'processing' / 'analyzing' / 'transcoding'` | The backend's only signal is `status: 'processing'` in the 202 response. Either simplify to a single "processing" state with an indeterminate progress bar, or poll `GET /clips/{id}/` until `status === 'ready'`. |
| `pages/Explore.tsx:60-69` | Free-text search input | Remove or wire to `?category=<text>`. The backend has no full-text search. |
| `components/audio/ReelCard.tsx:213-221` | `clip.tags.slice(0,4)` | Remove. `FeedClipSerializer` does not include `tags`. |
| `pages/Profile.tsx:24, 207` | "Liked" tab showing `prof.liked_clips` | Fix: call `profileAPI.getMyProfile()` for own profile (currently broken, calls `getProfile` instead). |
| `pages/Settings.tsx:25-30` | Settings rows for Privacy/Notifications/Language/Help/About | Remove (no backend endpoints). |
| `components/sharing/ShareModal.tsx:24, 65-74` | "Copy link" generating `/clip/<id>` | Remove or change to copy the HLS URL. |
| `data/clips.ts:12` | `CATEGORIES = ['instrumental', 'funny', 'news', 'science', 'music']` | This is a frontend curated list; the backend's `category` field is free-form. Keep the list but don't claim it's the backend's enum. |
| `data/demoClips.ts`, `data/creators.ts`, `data/demo.ts`, `data/demoInbox.ts`, `data/demoComments.ts` | Demo data files | Out of scope — keep but don't import from production paths. |

---

## 8. Backend capabilities with NO frontend consumer

| Backend capability | Frontend status | Recommendation |
| --- | --- | --- |
| `POST /auth/logout/` | Unused | Wire (FR-AUTH-4). |
| `PATCH /clips/{id}/` (edit title/category) | Unused | Add edit UI for own clips. |
| `DELETE /clips/{id}/` | Unused | Add delete UI for own clips. |
| `POST /comments/` with `parent` (replies) | Unused | Add reply UI. |
| `PATCH /comments/{id}/` (edit own) | Unused | Add edit UI. |
| `DELETE /comments/{id}/` (API wired, UI missing) | UI missing | Add delete affordance. |
| `Comment.author_id` for profile linking | Not in serializer | **Backend gap**: add `author_id` (or full author) to `CommentSerializer` so the frontend can link to author profile. |
| `AudioClip.tags` in feed responses | Not in `FeedClipSerializer` | **Backend gap**: add `tags` to `FeedClipSerializer.fields` so the UI can render them. |
| `POST /share/{id}/mark-read/` (correct method) | Used with wrong method (PATCH) | Fix the client. |
| Followers/following list endpoint | Doesn't exist on backend | Either remove the "Followers N" stat drill-down from the profile UI, or add a backend endpoint. |
| Sentry SDK init in backend | Already configured | Frontend has no error-reporting hook into Sentry (acceptable — `send_default_pii=False` means Sentry won't accept browser-source events anyway). |
| Prometheus metrics at `/metrics/` | n/a | Frontend never polls this. |
| Telemetry stream vs list fallback (`ECHOFLOW_TELEMETRY_STREAM`) | n/a | Operator-controlled; frontend is unaffected. |
| `ECHOFLOW_DUAL_WRITE_COUNTERS` env | n/a | Operator-controlled; frontend behavior unchanged (counters can lag by 5 min in Phase 2, which the UI should already tolerate). |
| Counter store / Redis pipeline | n/a | Backend internal. |
| `MAX_DURATION_SECONDS = 300` | n/a | Frontend should pre-validate to avoid round-trip 400. |

---

## 9. Frontend behaviors unsupported by backend (must remove or document)

| Frontend claim | Backend reality | Source |
| --- | --- | --- |
| Upload tags are sent | Backend ignores `tags` on upload | `serializers.py:37-46` (no `tags` in fields) |
| Free-text Explore search | Backend has no search endpoint | (no such endpoint) |
| `/clip/:id` route | No such route; no backend endpoint to back it | `app/router.tsx:30-37` (no `/clip` route) |
| Profile picture upload via Settings | Endpoint exists but no UI surfaces it | `views/profile.py:35-43` |
| `clip.tags` shown on cards | Not in feed serializer | `serializers.py:147-151` |
| Followers/following drill-down | No list endpoint | (none exists) |
| Privacy/Notifications/Language/Help/About screens | No backend endpoints | `pages/Settings.tsx:25-30` |
| `markRead` via PATCH | Backend is POST | `views/social.py:92-95` |
| `register()` auto-login | Register response has no tokens | `serializers.py:246-266` |
| Demo-mode auto-fallback when backend recovers | `feedAdapter.setBackendStatus(true)` is never called by the adapter | `data/feedAdapter.ts:9-12, 26-28` |
| Onboarding modal trigger after register | The new-user flag is set but the registration flow is broken | `stores/auth.tsx:58`, `stores/auth.tsx:52-61` |
| `profile_picture` is a usable URL | Field is a relative storage key; the frontend prefixes `apiBase` which doesn't match the MinIO endpoint | `serializers.py:277, 292` vs `atoms.tsx:33-34` |
| Periodic telemetry heartbeat | Only fires on player unmount | `stores/player.tsx:87-93` |
| `register-skip` on skip / completion | Never called | (missing) |

---

## 10. Quick reference — endpoint cheat sheet

For the implementing agent: every endpoint, every response shape.

```
AUTH
  POST /auth/register/         {username, password, email,                   → 201 User (no tokens)
                                consent_accepted, terms_version, dob}        | 400 {<field>: [<err>]}
  POST /auth/login/            {username, password}                         → 200 {access, refresh}
  POST /auth/token/refresh/    {refresh}                                    → 200 {access, refresh (new)}
  POST /auth/logout/           {refresh}                                    → 200/400 {detail}
  GET  /legal/compliance/      (no auth)                                    → 200 {compliance_officer,
                                                                          grievance_officer, nodal_contact,
                                                                          terms_versions: [str],
                                                                          current_terms_version, privacy_version,
                                                                          physical_address}

  # A1 (2026-09-29): consent_accepted and terms_version are REQUIRED, and
  # terms_version is validated against the server's list. Read
  # current_terms_version from /legal/compliance/ rather than hardcoding —
  # appending a version to TERMS_VERSIONS otherwise 400s every client.
  #
  # B1 (2026-09-29): dob is now REQUIRED (was optional, so a client could
  # dodge the DPDP §9 age gate by omission). If the computed age is under 18,
  # parent_email is required too and the account is flagged is_minor — and
  # POST /interactions/{id}/log-telemetry/ then returns 403 for that user.
  # Likes and skips are NOT gated. Future or >120-year-old dob is rejected.

FEED
  GET  /feed/                                                                → 200 {next, queue_health, results: FeedClip[]}
                                                                             | 202 {results: [], message, retry_after_ms, degraded}

EXPLORE
  GET  /suggestions/?category=X                                                 → 200 {next, previous, results: FeedClip[]}

COLD START
  POST /tags/initialize/   {selected_tags: [str, ...]}                          → 200 {status: "..."}
                                                                              | 400 {error: "Not enough data..."}

UPLOADS
  GET  /clips/                                                                  → 200 paginated list (AudioUploadSerializer)
  POST /clips/             multipart {original_file, title, category}            → 202 {message, clip_id, status}
                                                                              | 400 {<field>: [<err>]}
  PATCH /clips/{id}/       {title?, category?}                                  → 200 AudioUploadSerializer (original_file stripped)
  DEL  /clips/{id}/                                                              → 204

INTERACTIONS
  POST /interactions/{id}/toggle-like/        (empty body)                      → 200 {status: "liked"|"unliked"}
  POST /interactions/{id}/register-skip/      {listen_duration_ms, reel_position_ms, reel_id}
                                                                                → 201 {status: "skip/view registered"}
  POST /interactions/{id}/log-telemetry/      {action_type, watch_time_ms}      → 202 {status: "telemetry logged"}

COMMENTS
  GET  /comments/?clip=X&parent=Y                                              → 200 {next, previous, results: Comment[]}
  POST /comments/             {clip, text, parent?}                            → 201 Comment
  GET  /comments/{id}/                                                         → 200 Comment
  PATCH /comments/{id}/       {text}                                           → 200 Comment (author only)
  DEL  /comments/{id}/                                                          → 204 (author only)

SHARES
  GET  /share/                                                                 → 200 [ShareEvent]
  GET  /share/{id}/                                                            → 200 ShareEvent
  GET  /share/find-user/?username=X                                            → 200 {id, username} | 404
  POST /share/{clip_id}/send-share/   {receiver_id}                            → 201 {status: "shared successfully"}
  POST /share/{id}/mark-read/        (empty body, METHOD IS POST)             → 204
  DEL  /share/{id}/share-delete/                                               → 204
  GET  /share/inbox/                                                           → 200 [ShareEvent]
  GET  /share/unread-count/                                                    → 200 {unread}

FOLLOWS
  POST /follow/{user_id}/toggle-follow/                                        → 200 {status: "unfollowed"} | 201 {status: "followed"} | 400

PROFILES
  GET  /profile/me/                                                            → 200 OwnProfile
  PATCH /profile/me/update/   multipart {username?, profile_picture?}          → 200 OwnProfile
  GET  /profile/{id}/                                                          → 200 PublicProfile
  GET  /profile/{id}/clips/                                                    → 200 {next, previous, results: FeedClip[]}

INFRA
  GET  /health/                                                               → 200 {status, timestamp}
  GET  /ready/                                                                → 200 | 503
  GET  /metrics/                                                              → 200 Prometheus text
```

---

## 11. Implementation priorities

In order, to fix the broken pieces and close the most user-visible gaps:

1. **Auth & session correctness** — fix `stores/auth.tsx.register`
   to call `login` after register; add `authAPI.logout()` and call it
   from `logout()`; add the refresh-token rotation single-flight
   guard in `client.ts`.
2. **Fix `markRead` method** — change `client.ts:137` to POST.
3. **Cold-feed retry** — implement the `retry_after_ms` polling in
   `pages/Feed.tsx` and the 5-retry cap; surface `degraded` banner.
4. **Telemetry heartbeat** — add 5–10 s telemetry flush in
   `stores/player.tsx`; add skip telemetry on auto-advance.
5. **Own profile `liked_clips`** — use `getMyProfile()` when
   `targetId === user.id` in `pages/Profile.tsx`.
6. **Comment thread + edit + delete** — add reply UI; wire PATCH/DELETE.
7. **Clip edit + delete** — add UI for own clips.
8. **Profile picture upload UI** — wire the existing backend PATCH.
9. **Shareable link strategy** — replace `/clip/<id>` with copy of
   HLS URL or add a backend deep-link endpoint.
10. **Remove dead UI** — Upload tags input, Explore free-text search,
    Settings rows without backend, fake upload processing stages,
    `clip.tags` rendering on cards.
11. **Backend additions (separate PRs)** —
    - ~~Add `tags` to `FeedClipSerializer.fields`.~~ **DONE 2026-09-29** (A2).
    - ~~Add `author_id` to `CommentSerializer`.~~ **DONE 2026-09-29** (A5).
      Exposes the bare id, not the profile — the client still calls
      `GET /profile/{id}/` for anything richer.
    - Add a profile-picture URL helper that returns an absolute URL
      (signed if necessary).
    - ~~Add `duration_ms` to `FeedClipSerializer.fields`.~~ **DONE
      2026-09-29** (A2), alongside `tags`.
    - ~~Publish `terms_versions` on `GET /legal/compliance/`.~~ **DONE
      2026-09-29** (A1), with `privacy_version` and `physical_address`.

---

## Appendix A — Source code citations

All requirements above are traceable to the following files:

- `backend/app/models.py` — domain model, counters, vectors,
  constraints, comment counter side-effects.
- `backend/app/serializers.py` — request/response shapes, validation,
  magic-byte/MIME sniff, duration probe.
- `backend/app/urls.py` — router, auth endpoints, throttle wiring.
- `backend/app/views/__init__.py` — viewset registry.
- `backend/app/views/auth.py` — register endpoint.
- `backend/app/views/content.py` — clip CRUD, 202 on create,
  original_file strip on update.
- `backend/app/views/feed.py` — feed list (3 response shapes),
  suggestions, cold-start tag initializer, vector cache.
- `backend/app/views/interactions.py` — like/skip/telemetry endpoints,
  per-action throttle.
- `backend/app/views/social.py` — share/follow/inbox/mark-read (POST).
- `backend/app/views/comments.py` — comments, IsAuthorOrReadOnly,
  queryset scoping.
- `backend/app/views/profile.py` — me, update, retrieve, user_clips.
- `backend/app/views/_pagination.py` — cursor pagination classes.
- `backend/app/services/interactions.py` — counter side-effects,
  telemetry stream/list/sync fallback, cache invalidation.
- `backend/app/services/comments.py` — comment create/update/delete.
- `backend/app/services/follows.py` — follow toggle.
- `backend/app/services/shares.py` — share transactional flow.
- `backend/app/services/uploads.py` — transaction.on_commit dispatch.
- `backend/app/services/task_publisher.py` — correlation-id propagation.
- `backend/app/services/feed_pool.py` — Redis pre-computed pools.
- `backend/app/services/counter_store.py` — Redis counter dual-write.
- `backend/app/services/sentry.py` — Sentry capture with correlation_id.
- `backend/app/tasks.py` — `process_audio_to_hls`, `refill_user_feed`
  shim, `update_global_metrics`, `evolve_long_term_user_baselines`,
  `flush_telemetry_legacy`, `flush_telemetry_stream`,
  `cleanup_stuck_processing`, `scrape_and_import`,
  `cleanup_orphan_hls`, `flush_counters_to_pg`.
- `ai_ml/pipelines/feed_tasks.py` — `refill_user_feed`,
  `rebuild_global_exploit_pool`, `dispatch_user_pool_rebuilds`,
  `rebuild_user_explore_pool`.
- `backend/app/media_urls.py` — HLS playback URL generation,
  signed media URL helper.
- `backend/app/signals.py` — post_delete cleanup of HLS + original.
- `backend/app/apps.py` — Sentry init, signal registration.
- `backend/app/db_routers.py` — read-replica routing.
- `backend/app/metrics.py` — Prometheus histograms/counters exposed
  at `/metrics/`.
- `backend/app/admin.py` — empty (no admin registered).
- `backend/app/management/commands/scrape_audio.py` — operator CLI
  for ingesting from external archives.
- `ai_ml/scrapers/*` — operator-side scraping (no frontend
  interaction).
- `backend/EchoFlow/settings.py` — JWT TTLs, throttle rates,
  CORS/cookie policy, S3 storage config, Celery beat schedule,
  read replica configuration.
- `backend/EchoFlow/celery.py` — task autodiscovery, correlation-id
  propagation, Celery metrics instrumentation.
- `backend/EchoFlow/middleware.py` — CorrelationIdMiddleware.
- `backend/EchoFlow/health.py` — `/health/`, `/ready/`.
- `backend/EchoFlow/correlation.py` — contextvar storage.
- `backend/EchoFlow/sentry.py` — Sentry SDK init.
- `frontend/sample_frontend/src/api/client.ts` — current API client
  (broken in places, see §2.1).
- `frontend/sample_frontend/src/stores/auth.tsx` — broken registration
  flow, no logout API call.
- `frontend/sample_frontend/src/stores/player.tsx` — only-on-unmount
  telemetry, no skip telemetry.
- `frontend/sample_frontend/src/pages/Upload.tsx` — fake processing
  states, dead tags input.
- `frontend/sample_frontend/src/pages/Feed.tsx`,
  `data/feedAdapter.ts` — no 202 retry handling, no degraded banner.
- `frontend/sample_frontend/src/pages/Explore.tsx` — no pagination,
  dead free-text search.
- `frontend/sample_frontend/src/pages/Profile.tsx` — wrong endpoint
  for own profile.
- `frontend/sample_frontend/src/pages/Inbox.tsx` — wrong markRead
  method.
- `frontend/sample_frontend/src/components/comments/CommentSheet.tsx`
  — no replies, no edit, no delete.
- `frontend/sample_frontend/src/components/sharing/ShareModal.tsx` —
  broken share-link copy.
- `frontend/sample_frontend/src/components/feed/OnboardingModal.tsx`
  — never triggered (register flow broken).
- `frontend/sample_frontend/src/components/audio/ReelCard.tsx` —
  renders `clip.tags` (not in serializer).
- `frontend/sample_frontend/src/app/router.tsx` — no `/clip/:id`
  route, full-page-reload navigation.
- `frontend/sample_frontend/src/components/common/atoms.tsx` —
  incorrect `profile_picture` URL prefix.
