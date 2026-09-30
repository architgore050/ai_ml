<task id="ses_f0f1f7f7affeZ2HXXtp6FBprzL" state="completed">
<task_result>
All traces complete. Here is the report.

---

# RECON-03 — Data Truthfulness / Fabricated Data

**Agent:** R3 · **Read-only** · no files modified, no git writes.
**Method:** every UI datum traced to a serializer/view/model line, or proven absent by grep.

---

## 1. Verdict table

| # | Claim (file:line) | Status | Evidence | User impact | Severity |
|---|---|---|---|---|---|
| 1 | `ShareModal.tsx:17-22` — 4 hardcoded "Network Peers" (`id:1 alex`, `2 roastmaster`, `3 curiosity_lab`, `4 stoic_focus`) with live **Stream** buttons | **CONFIRMED-FABRICATED** | `views/social.py:164` `get_object_or_404(User, id=receiver_id)`; ids are real PKs | **Writes real `ShareEvent` rows + `shares` counter increments + unread inbox items to arbitrary real users.** Green "Sent" follows. Live data corruption | **CRITICAL** |
| 2 | `ShareModal.tsx:26,149` — `sentUsers: Record<number,boolean>` keyed by recipient only, state survives close (`if (!isOpen…) return null` at `:66`, never unmounted) | **CONFIRMED-MISLEADING** | `Feed.tsx:179-183` always mounts it | Row shows "Sent" for a clip it was never sent. User believes a share was delivered | High |
| 3 | `ReelCard.tsx:283` — hardcoded quote rendered as the clip's content | **CONFIRMED-FABRICATED** | `grep transcript backend/app/models.py backend/app/serializers.py` → **0 hits**. No field exists | Every card shows identical fake text styled as a transcript. Highest-deception item in the feed | High |
| 4 | `ReelCard.tsx:298` — `192kbps ABR` under "HLS Stream" | **CONFIRMED-FABRICATED** | `tasks.py:362` `'-b:a','128k'`, **no `var_stream_map`** → 1 variant, not 3 | Wrong bitrate *and* claims adaptive streaming that does not exist; also backs the Pro/HD upsell | High |
| 5 | `Upload.tsx:163` "Worker task dispatched … active" + `:165-167` "Directing to live feed…" | **CONFIRMED-FABRICATED** | `services/uploads.py:18-50` — `finalize_upload` "deliberately does NOT enqueue"; only `approve-moderation` → `trigger_hls_processing` (`:82`) enqueues | **Nothing runs. The clip never appears in the feed.** 2.5 s later the user is dumped on an empty feed | High |
| 6 | `Upload.tsx:275` "FFmpeg 3-tier ABR … Whisper-v3 Large … Librosa 128-dim MFCC" | **CONFIRMED-FABRICATED** | `tasks.py:44` `WhisperModel("base")`; `tasks.py:104-113` mfcc(40)+chroma(12)+mel(76); `tasks.py:360-367` single-variant | Three false infra claims; file **self-contradicts** at `:163` ("chroma") vs `:275` ("MFCC") | High |
| 7 | `Upload.tsx:30,42-44,217` — "MAX 100 MB • MAX 300S" as universal | **CONFIRMED-MISLEADING** | `serializers.py:264-276` free tier = **10 MB**; `views/content.py:194-207` free tier = **5/day**; `serializers.py:338` 300 s is tier-blind | Free user told 100 MB, gets a 400. The two limits that *do* bite are never shown | High |
| 8 | `Profile.tsx:172` — `Joined: {new Date(date_joined \|\| Date.now())…}` | **CONFIRMED-FABRICATED** | — | On any failed/pending profile fetch, renders **today's date as the account creation date** | High |
| 9 | `Profile.tsx:70-74` silent `catch` + `:207/213/219` `\|\| 0` + `:262` "No audio reels published to network." | **CONFIRMED-MISLEADING** | — | A 500 renders "0 followers / 0 following / 0 Audio Reels" and "No audio reels published to network." Failure is displayed as fact | High |
| 10 | `Profile.tsx:164-166` — `CREATOR` badge on every profile | **CONFIRMED-FABRICATED** | `grep is_creator` → 0 hits; no such model/serializer field | A user who never uploaded is badged a creator | Medium-High |
| 11 | `CommentSheet.tsx:84` — `Discussions ({comments.length})` | **CONFIRMED-MISLEADING** | `_pagination.py:11` `page_size=20`; `ReelCard.tsx:430` shows the real `clip.comment_count` | Header says ≤20, reel says e.g. 340. Two counts of one thing, on screen at once | Medium-High |
| 12 | `CommentSheet.tsx:113-164` flat list; `reply_count` never read; `?parent=` never sent | **CONFIRMED-MISLEADING** | `serializers.py:529-532` `reply_count`; `views/comments.py:52` `filterset_fields=['clip','parent']` | Replies render as top-level siblings with no indent or marker; a parent's replies are invisible as replies | Medium-High |
| 13 | `CommentSheet.tsx:37-41` silent `catch` → `:107` "No comments yet" | **CONFIRMED-MISLEADING** | — | Load failure is displayed as an empty thread | Medium |
| 14 | `Explore.tsx:159` — `{Math.max(15, clip.likes + clip.shares * 2)} Listens` | **CONFIRMED-FABRICATED** | `grep listen_count\|view_count\|play_count\|impression_count\|total_plays backend/` → **0 hits** | Invented social-proof number with a floor that guarantees a plausible minimum | Medium-High |
| 15 | `ReelCard.tsx:149-150` — `vectorStr` "Acoustic Vector" + `similarityScore` | **CONFIRMED-FABRICATED** | `views/feed.py:210-215` annotates `combined_distance` but **never serializes it**; `FeedClipSerializer.Meta.fields` has no vector/score | Engagement integers dressed as embedding-space output | Medium |
| 16 | `ReelCard.tsx:148,169` — `CLIP_ID: EF-{shortId}` | **CONFIRMED-FABRICATED** | `id` is a UUID4 (`models.py:109`); `EF-` prefix invented | Presented as a resolvable ID; 8 hex chars collide in practice | Medium |
| 17 | `Feed.tsx:164` `hasMore={false}` → `ReelList.tsx:148-161` "All caught up" | **CONFIRMED-MISLEADING** | `views/feed.py:123-127` returns `next` + `queue_health`; both unused | Asserts completeness the server never asserted. `queue_health` fetched, never read | Medium |
| 18 | `Profile.tsx:239` — `My Uploads ({userClips.length})` | **CONFIRMED-MISLEADING** | `_pagination.py:6` `page_size=10`; `views/profile.py:75-77`; real total is `uploads_count` (`views/profile.py:26`) | Caps at 10 and disagrees with the "Audio Reels" stat two elements above it | Medium |
| 19 | `Profile.tsx:251` — `Liked Reels (liked_clips.length)` | **CONFIRMED-MISLEADING** | `serializers.py:831` `.order_by(…)[:50]` | Says "50" for a user with 500 likes. Backend supplies the real thing; frontend hides it | Medium |
| 20 | `Inbox.tsx` — **no timestamp rendered at all** | **CONFIRMED-MISLEADING** (inverse) | `serializers.py:583` `'created_at'`; `models.py:241` | Backend supplies it; the one screen where "how old is this share" matters shows nothing | Medium |
| 21 | `Feed.tsx:139` — "Hands-Free Auto-advance: ON" / "Manual Navigation Mode" | **CONFIRMED-MISLEADING** | `ReelList.tsx:98-106`, `player.tsx:86-88,104-106,166-178` — **no `handsFreeMode` guard anywhere**; only `Header.tsx:137` writes it | Flipping it off changes one string. Auto-advance continues identically | Medium |
| 22 | `OnboardingModal.tsx:11-20` — 8 hardcoded "vibes" | **PARTLY-FABRICATED** | `views/feed.py:264-275` `Q(tags__contains=[tag])`; `tasks.py:292,296` tags are free-form KeyBERT keywords or `["instrumental"]` | Selecting "comedy" matches nothing → `400 "Not enough data to build baseline."` Cold start is mostly a dead end | Medium |
| 23 | `player.tsx:81,99,171,333-334` — `watch_time_ms` = media **position**, not delta | **CONFIRMED-FABRICATED** (data-integrity) | `services/interactions.py:282-283` `completion_rate = min(watch_time_ms / clip_duration, 1.0)` | A paused-at-99% user reports 0.99 completion repeatedly; `completion_rate` is **30 % of the ranking composite**. Seek inflates it | Medium-High |
| 24 | `Profile.tsx:467-478` — clip-edit category `<select>` hardcoded to 6 options | **PARTLY-FABRICATED** | `models.py:112` `category` is free-form `CharField`; Onboarding offers 8 | A clip tagged `tech`/`mindset` opens an edit form with **no matching option**; saving can silently rewrite the category | Medium |
| 25 | `Explore.tsx:63-69,97` — "PGVECTOR_384D", "clustered by semantic embeddings and acoustic vectors" | **PARTLY-FABRICATED** | `views/feed.py:209-215` only annotates when `get_user_vectors` returns both; else `order_by('-engagement_velocity')` (`:222`) | On cold start (no vectors) the page still claims personal vector ranking. Also: 384-dim is only the semantic half; acoustic is 128 | Medium |
| 26 | `Profile.tsx:169` — renders `profile.email`; `types/echoflow.ts:36` types it `string` | **CONFIRMED-MISLEADING** (type lies) | `serializers.py:779-785` `OwnProfileSerializer.fields` has **no `email`** | The line can never render. `auth.tsx:36` writes `undefined` into storage | Medium |
| 27 | `Profile.tsx:148` renders `profile_picture`; ignores the signed `profile_picture_url` | **CONFIRMED-MISLEADING** | `serializers.py:740,752-755` signed variant exists; `:746` raw field also exposed | Unsigned `/media/…` URL; avatar silently falls back to the initial (security agent's lane, noted for blast radius) | Medium |
| 28 | `ReelCard.tsx:255-257` — idle waveform `((idx*17)%65)+20` | **CONFIRMED-FABRICATED** (decoration) | `player.tsx:138-164` — `Math.sin` envelope, no `AnalyserNode` (code comments are honest) | Shapes imply measured audio. Low: acknowledged as decorative in source | Low |
| 29 | `App.tsx:30-33` — `setUnreadCount(data.unread \|\| 0)`, `catch {}` | **CONFIRMED-MISLEADING** | `views/social.py:208-211` real | Badge shows "0 unread" (i.e. "you have no unread shares") whenever the poll fails | Low |
| 30 | `CommentSheet.tsx:114` — `isAuthor` by `username`; `author_id` ignored | **IMPRECISE** | `serializers.py:521` `author_id` supplied | A user who renames loses Delete on their own comments | Low |
| 31 | `CommentSheet.tsx:128` — `toLocaleTimeString` (time, no date) | **IMPRECISE** | `created_at` is a full datetime | A 3-week-old comment shows a bare time | Low |

**Not fabricated (verified correct — see §10):** `Upload.tsx:158` "Ingestion Accepted (202)"; `Profile.tsx:414` "Max 5MB"; `Feed.tsx:130` degraded banner; `Header.tsx` health indicator; `Profile.tsx:294` per-clip engagement; `ReelCard.tsx:412/430/448` counters; `App.tsx` unread badge (on success); `OnboardingModal.tsx:124` tag count; `client.ts` POST-only playback token; `player.tsx:223-231` 409/403/404 mapping.

---

## 2. Per-finding detail

### 1. `DEFAULT_PEERS` — CRITICAL

```tsx
// frontend/src/components/sharing/ShareModal.tsx:17-22
const DEFAULT_PEERS: PeerUser[] = [
  { id: 1, username: "alex" },
  { id: 2, username: "roastmaster" },
  { id: 3, username: "curiosity_lab" },
  { id: 4, username: "stoic_focus" },
];
```
```tsx
// :148  rendered whenever no search result is present
{(foundUser ? [foundUser] : DEFAULT_PEERS).map((peer) => {
// :166  live, destructive button
onClick={() => handleSendToUser(peer.id)}
```
```python
# backend/app/views/social.py:159-172
if str(receiver_id) == str(request.user.pk): ...
receiver = get_object_or_404(User, id=receiver_id)      # <-- real PK lookup
clip = get_object_or_404(AudioClip.objects.filter(status='ready', moderation_approved=True), pk=pk)
```
```python
# backend/app/models.py:238-239  — ShareEvent rows are real
sender   = models.ForeignKey(..., related_name='sent_shares', on_delete=CASCADE)
receiver = models.ForeignKey(..., related_name='received_shares', on_delete=CASCADE)
```

The ids are not sentinels — they are `User` primary keys. `send_share` will happily resolve `id: 4` to whatever human holds pk 4, create a `ShareEvent`, bump `AudioClip.shares` (via `UserInteraction.save()` → `counter_store.increment`, `models.py:315`), and drop an unread item in that stranger's inbox. The frontend then renders a green "Sent" (`:174-178`), so **nothing on screen indicates the recipient was invented.**

**Real value the API returns:** nothing — there is no peer/contact/suggestion endpoint. `GET /share/find-user/?username=` (`views/social.py:114-125`) is the only directory, and it is exact-match, case-insensitive, 404s honestly.

**Minimal honest fix:** delete `DEFAULT_PEERS` and the `DEFAULT_PEERS` branch at `:148`; render an empty-state prompt when `foundUser` is null. The search flow above it already works and needs no backend change.

---

### 2. `sentUsers` keyed by recipient alone — High

```tsx
// :26
const [sentUsers, setSentUsers] = useState<Record<number, boolean>>({});
// :149
const isSent = sentUsers[peer.id];
// :66  — returns null but the component stays MOUNTED, so useState persists
if (!isOpen || !clip) return null;
```
`Feed.tsx:179-183` renders `<ShareModal>` unconditionally, so React never remounts it. After sending to user 4 for clip A, opening clip B shows that row disabled and labelled "Sent".

**Minimal honest fix:** key by `` `${clip.id}:${peer.id}` `` (COMPLETION_PLAN C1 already says this), or reset the map in a `useEffect` on `clip?.id`.

---

### 3. Hardcoded transcript — High

```tsx
// frontend/src/components/feed/ReelCard.tsx:282-284
<p className="text-xs sm:text-sm font-medium text-white/60 max-w-lg border-l-4 border-[#FF6321] pl-4 my-2 leading-relaxed">
  &ldquo;Sound travels without pixels. Listen attentively as the vector engine streams pure lossless thought.&rdquo;
</p>
```
It sits directly under the clip's real title, in a quote-marked block with the accent border — the visual grammar of a transcript. It also asserts "pure lossless", which is false for the AAC encode at `tasks.py:362`.

**Proof of absence:**
```
$ grep -n "transcript" backend/app/models.py backend/app/serializers.py
(no output)
```
The transcript exists only as a local variable inside the worker (`tasks.py:277`), used for embedding (`:282`) and moderation (`:322`). It is never persisted and never serialized.

> **Correction to the prior audit.** `docs/frontend_rebuild_plan.md:68` states *"A real `transcript` field exists."* **It does not.** This is therefore **not** a client-side rewire — it needs a new column + serializer field (or the text must be deleted). Severity is higher than the audit recorded because there is no cheap fix.

**Minimal honest fix (MVP):** delete the block. Do not substitute a placeholder.

---

### 4. `192kbps ABR` — High

```tsx
// frontend/src/components/feed/ReelCard.tsx:296-299
<div className="flex flex-col">
  <span className="text-white/30 font-bold mb-0.5">HLS Stream</span>
  <span className="text-green-400 font-bold">192kbps ABR</span>
</div>
```
```python
# backend/app/tasks.py:360-367  — the entire encode
command = [
    'ffmpeg', '-y', '-i', normalized_path,
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k',
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'mpegts',
    '-master_pl_name', 'master.m3u8',
    os.path.join(local_hls_dir, 'index.m3u8')
]
```
No `var_stream_map` → **one** variant. The bitrate is 128k, not 192k. There is no adaptive bitrate selection at any layer. The green colour is the worst part: it is styled as a healthy instrument reading.

> **Correction to the prior audit.** `frontend_rebuild_plan.md:69` says *"`HLS_BUCKETS` is server-side config"*. `HLS_BUCKETS` is `backend/app/metrics.py:132` — a **Prometheus histogram bucket tuple in seconds** `(1.0, 5.0, 15.0, …, 600.0)`, unrelated to bitrate. There is no server-side bitrate config at all.

**Minimal honest fix:** delete the strip (see #15 — the whole telemetry row goes).

---

### 5. Upload "worker dispatched" / "directing to live feed" — High

```tsx
// frontend/src/pages/Upload.tsx:162-167
<div className="p-4 rounded-xl bg-black/60 …">
  Worker task dispatched: Faster-Whisper transcribing, Librosa chroma vector
  extraction & 3-tier HLS packaging active...
</div>
<p className="… animate-pulse">Directing to live feed...</p>
```
```python
# backend/app/services/uploads.py:18-34
def finalize_upload(clip: AudioClip) -> None:
    """… DECISION: This deliberately does NOT enqueue ``process_audio_to_hls``. …
    The enqueue has to happen *after* ``run_moderation_check`` approves, which is
    what ``approve-moderation`` does via ``trigger_hls_processing``."""
    if clip.moderation_approved:
        clip.moderation_approved = False
        clip.save(update_fields=["moderation_approved"])
```
`POST /clips/` calls `finalize_upload` (`views/content.py:213`) and returns `202` with `status: "processing"`. **No task is enqueued, no whisper runs, no HLS is written, and `moderation_approved` is explicitly forced False** — which guarantees the worker would bail at its own gate anyway (`tasks.py`, `if not clip.moderation_approved: return`).

The clip sits at `processing` for ever. The UI asserts a four-stage pipeline is running and then hard-navigates to the feed after 2.5 s (`Upload.tsx:125-127`) — where the clip is absent. `clip_id` **is** returned (`views/content.py:219`) and is displayed (`:160`) but never polled; `GET /clips/{id}/` exists and returns `status`.

**Minimal honest fix:** replace the fabricated stage copy with a single honest "Awaiting moderation approval" line plus the real `clip_id`, and either poll `GET /clips/{id}/` or stop claiming progress. Remove `onUploadSuccess()` auto-navigation.

---

### 6. Pipeline spec claims — High

```tsx
// frontend/src/pages/Upload.tsx:273-276
<span className="font-bold text-[#FF6321]">PIPELINE SPEC: </span>
FFmpeg 3-tier ABR HLS transcoding • Whisper-v3 Large automatic speech recognition
• Librosa 128-dim MFCC acoustic vectorization.
```
| UI claim | Reality | Source |
|---|---|---|
| 3-tier ABR HLS | 1 variant, 128 kbps | `tasks.py:360-367` |
| Whisper-v3 Large | `WhisperModel("base", device="cpu", compute_type="int8")` | `tasks.py:44` |
| 128-dim MFCC | 128-dim = **mfcc(40) ⊕ chroma(12) ⊕ mel(76)** | `tasks.py:104-113` |

And the file contradicts itself: `:163` says "chroma vector extraction", `:275` says "MFCC". A real Anki reviewer reading the success screen then the form would conclude two different pipelines exist.

**Minimal honest fix:** rewrite to `FFmpeg HLS (AAC 128 kbps) • faster-whisper "base" • librosa 128-dim (MFCC+chroma+mel)`, or delete the block.

---

### 7. Upload limits — High

```tsx
// frontend/src/pages/Upload.tsx:30
if (f.size > 100 * 1024 * 1024) { setErrorMessage("File exceeds the 100 MB limit."); return; }
// :42-44
if (dur > 300) { setErrorMessage(`Audio duration (${dur}s) exceeds … 300 seconds (5 minutes).`); }
// :217
MP3, WAV, OGG, M4A, FLAC • MAX 100 MB • MAX 300S (5 MIN)
```
```python
# backend/app/serializers.py:264-276 — free tier, enforced
max_mb = getattr(django_settings, "REVENUECAT_UPLOAD_MAX_SIZE_MB_FREE", 10)
if original_file and original_file.size > max_size:
    raise serializers.ValidationError({"original_file": f"Free tier upload limit is {max_mb}MB. …"})
```
```python
# backend/app/views/content.py:194-207 — free tier, enforced
daily_limit = getattr(django_settings, "REVENUECAT_DAILY_UPLOAD_LIMIT_FREE", 5)
if created_today >= daily_limit: raise PermissionDenied(f"Free tier limit of {daily_limit} daily uploads reached. …")
```
The 100 MB figure is the *Pro*/absolute ceiling (`serializers.py:195 MAX_SIZE`). A free user is shown a limit **10× larger** than the one that will reject them, and neither of the two limits that actually fires (10 MB, 5/day) appears anywhere on the page. The 300 s gate is real but tier-blind — see `docs/EXPLAIN/decisions/2026-09-29-unenforced-subscription-limits.md`, which records that the advertised 60 s free cap is enforced nowhere.

**Minimal honest fix:** read the real limits from `GET /subscription/` (`views/subscription.py`, already implemented) instead of hardcoding, or at minimum state the 10 MB / 5-per-day free-tier values.

---

### 8. `date_joined || Date.now()` — High

```tsx
// frontend/src/pages/Profile.tsx:171-173
<p className="text-[10px] font-mono uppercase text-white/30 mt-1">
  Joined: {new Date(currentDisplayProfile?.date_joined || Date.now()).toLocaleDateString()}
</p>
```
`currentDisplayProfile` is `profile` (own) or `publicProfile` (other), both of which are `null` until their fetch resolves. During loading, on a 500, or after `refreshProfile()` swallows its error (`auth.tsx:40-42` — bare `console.warn`, state stays `null`), this renders **today's date as the account's creation date.** On someone else's profile it is a fabricated fact about a third party.

**Minimal honest fix:** render an em dash (or skeleton) when the value is absent. `date_joined` is `read_only` and always present on a successful response (`serializers.py:748,784`).

---

### 9. Plausible zeros + silent failure — High

```tsx
// frontend/src/pages/Profile.tsx:70-74
} catch (err) {
  console.warn("Error loading profile:", err);
} finally { setIsLoading(false); }
```
```tsx
// :206-208, :212-214, :218-220
{currentDisplayProfile?.followers_count || 0}   // Followers
{currentDisplayProfile?.following_count  || 0}   // Following
{currentDisplayProfile?.uploads_count   || 0}   // Audio Reels
// :262
No audio reels published to network.
```
A 500, a 401, or a network drop produces a fully-rendered profile reading **0 / 0 / 0** and **"No audio reels published to network."** The user is told a fact about their own library that is false, with no error affordance anywhere on the page. `refreshProfile()` has the same shape at `auth.tsx:40-42`, so the failure is invisible at both layers.

**Minimal honest fix:** distinguish `loading` / `error` / `loaded`; render a skeleton while loading and an explicit error state on failure. Never a plausible zero.

---

### 10. `CREATOR` badge — Medium-High

```tsx
// frontend/src/pages/Profile.tsx:164-166
<span className="px-2 py-0.5 rounded bg-[#FF6321]/15 text-[#FF6321] …">
  CREATOR
</span>
```
Unconditional — no `isOwnProfile` guard, no condition at all. `grep is_creator backend/` → 0 hits. There is no creator tier, no flag, and no concept of one in `User` (`models.py:14-79`). A brand-new account with zero uploads is badged CREATOR.

**Minimal honest fix:** delete. If a tier is wanted, it needs a backend field first (§3).

---

### 11-13. Comment sheet — Medium-High

```tsx
// frontend/src/components/comments/CommentSheet.tsx:84
Discussions ({comments.length})
```
```python
# backend/app/views/_pagination.py:10-12
class CommentCursorPagination(CursorPagination):
    page_size = 20
```
`comments.length` is the length of **one page of 20**, of which the frontend fetches exactly one (`client.ts:316-323` builds the query and discards `next`). Meanwhile `ReelCard.tsx:430` renders the authoritative `clip.comment_count` on the reel behind the sheet. The two counts of the same quantity disagree on screen simultaneously, and the sheet's is always ≤ 20.

```tsx
// CommentSheet.tsx:113  — flat map, `parent` never read
comments.map((comment) => { … <span>@{comment.author_username}</span> … })
```
```python
# backend/app/serializers.py:529-532
def get_reply_count(self, obj):
    if not obj.parent_id: return obj.replies.count()
    return 0
```
`views/comments.py:52` exposes `filterset_fields = ['clip','parent']` and `client.ts:319-321` already knows how to send `parent` — but `CommentSheet` never passes it. So the sheet receives top-level comments **and** their replies interleaved by `-created_at`, renders every one as a top-level row, and discards the `reply_count` that would let it show "3 replies". A reply to a deleted parent, or a two-deep thread, is indistinguishable from a root comment.

```tsx
// :37-41
} catch (err) { console.warn("Could not load comments:", err); }
// :106-110  →  "No comments yet" / "Be the first to share your reaction…"
```
A failed fetch is displayed as an empty thread, and the copy actively invites the user to post the first comment on a thread that already has 340.

**Minimal honest fix:** (a) use `clip.comment_count` for the header; (b) nest on `parent` and render `reply_count`; (c) add an error branch distinct from empty.

---

### 14. Explore "Listens" — Medium-High

```tsx
// frontend/src/pages/Explore.tsx:157-160
<span className="flex items-center gap-1">
  <Headphones className="w-3 h-3" />
  {Math.max(15, clip.likes + clip.shares * 2)} Listens
</span>
```
**Proof of absence:**
```
$ grep -rn "listen_count\|view_count\|play_count\|impression_count\|total_plays\|num_plays" backend/ --include=*.py
(no output)
```
`AudioClip` (`models.py:108-171`) has `likes`, `shares`, `skips`, `comment_count`, `avg_completion_rate`, `engagement_velocity` — and **no view/listen counter of any kind**. The `skips` counter is the closest thing and is deliberately not shown. The `Math.max(15, …)` floor guarantees a non-zero number even for a clip with zero engagement, i.e. it asserts a minimum audience that provably does not exist.

**Minimal honest fix:** delete the row. `duration_ms` and `tags` are real and already in the payload.

---

### 15-16. ReelCard telemetry strip — Medium

```tsx
// frontend/src/components/feed/ReelCard.tsx:147-150
// Generate pseudorandom vector hash string based on clip ID
const shortId = clip.id.replace(/-/g, "").slice(0, 8).toUpperCase();
const vectorStr = `v[0.${((clip.likes * 13) % 89 + 10)}, -0.${((clip.shares * 19) % 79 + 10)}, 0.99]`;
const similarityScore = (0.92 + (clip.likes % 7) * 0.01).toFixed(3);
```
Rendered as (`:288-299`): `Acoustic Vector: v[0.55, -0.29, 0.99]`, `Similarity Score: 0.923 Match`, `HLS Stream: 192kbps ABR`, plus `CLIP_ID: EF-{shortId}` at `:169`.

The source comment says "pseudorandom" — it is worse than that, it is **deterministic arithmetic on two engagement integers**, so a clip's "similarity score" is a pure function of its like count modulo 7. Two different clips with `likes % 7 == 0` both display exactly `0.920 Match`.

**Proof of absence.** `views/feed.py:210-215` *does* compute a real score:
```python
queryset = queryset.annotate(combined_distance=(
    CosineDistance('semantic_vector', sem_query) +
    CosineDistance('acoustic_vector', ac_query)
)).order_by('combined_distance')
```
…but `combined_distance` is an annotation only. `FeedClipSerializer.Meta.fields` (`serializers.py:395-410`) does not include it, and neither `semantic_vector` nor `acoustic_vector` is ever serialized. **The real value exists in the query and dies at the serializer boundary.** That is the cheapest possible fix in this whole report: add one field.

Also `clip.id` is a UUID4 (`models.py:109`); `EF-` is invented and 8 hex chars collide in practice, so the displayed "ID" resolves to nothing.

**Minimal honest fix:** delete the strip; add `combined_distance` to `FeedClipSerializer` **only if** a real match score is wanted. `tags` (`serializers.py:409`) and `duration_ms` are already in the payload and currently render nowhere.

---

### 17-19. Pagination — Medium

```tsx
// frontend/src/pages/Feed.tsx:160-168
<ReelList clips={clips} loading={isLoading} err={errorMsg} hasMore={false} … />
// frontend/src/components/feed/ReelList.tsx:148-161
{!hasMore && clips.length > 0 && ( … All caught up )}
```
```python
# backend/app/views/feed.py:123-127
return Response({"next": "auto_trigger", "queue_health": queue_length, "results": serializer.data})
```
`hasMore` is a hardcoded `false`, so "All caught up" renders unconditionally after the first page. The server has asserted nothing of the sort. `queue_health` (the actual remaining-queue length) and `next` are both in `types/echoflow.ts:76-77` and read by **nothing**.

```tsx
// frontend/src/pages/Explore.tsx:37-38
const res = await feedAPI.getSuggestions(cat);
setClips(res.results);          // `next` discarded
```
`_pagination.py:6` `page_size=10` → Explore shows 10 of N with no affordance and no explanation.

```tsx
// frontend/src/pages/Profile.tsx:239, 251
<span>My Uploads ({userClips.length})</span>
<span>Liked Reels ({profile?.liked_clips?.length || 0})</span>
```
`My Uploads` is capped at 10 by `FeedCursorPagination` and is displayed 30 px above `uploads_count` (`Profile.tsx:219`) which is the real total. `Liked Reels` is capped at 50 by the backend itself (`serializers.py:831` `[:50]`) — the number is honest about what it received and dishonest about the total.

**Minimal honest fix:** use `uploads_count` for the uploads tab label; drop the `next`-ignoring page-size claims or implement the cursor.

---

### 20. Inbox has no timestamp — Medium

`grep created_at frontend/src/pages/Inbox.tsx` → **0 hits**. `ShareEventSerializer` supplies it (`serializers.py:583`) and `types/echoflow.ts:71` declares it. The inbox is the one screen where "is this from five minutes ago or five months?" is the entire decision, and it renders `sender_name`, `clip_title`, `creator_name`, `category`, `NEW` — and no time. `clip_hls_url` (`serializers.py:582`) is likewise supplied and unused.

**Minimal honest fix:** render a relative timestamp. One line, no backend change.

---

### 21. Hands-free toggle — Medium

```tsx
// frontend/src/pages/Feed.tsx:138-140
<span>{handsFreeMode ? "Hands-Free Auto-advance: ON" : "Manual Navigation Mode"}</span>
```
`handsFreeMode` is written by exactly one place (`Header.tsx:137`) and read by exactly one place (that label). The three auto-advance paths have **no guard**:
- `ReelList.tsx:98-106` — scroll-snap effect
- `player.tsx:86-88` — `timeupdate` at `cur/dur >= 0.99`
- `player.tsx:104-106, 166-178` — `ended` → `handleAutoAdvance`

Independently confirmed by `docs/frontend/RECON-01-media-player.md:222`. Turning it off changes a string.

**Minimal honest fix:** either gate the three paths on the flag (the toggle then means what it says) or delete the toggle. Gating is 3 lines.

---

### 22. Onboarding "vibes" — Medium

`OnboardingModal.tsx:11-20` offers 8 fixed tags. The backend does an exact JSONB containment match:
```python
# backend/app/views/feed.py:264-275
tag_filter = Q()
for tag in selected_tags: tag_filter |= Q(tags__contains=[tag])
baseline_clips = AudioClip.objects.filter(tag_filter, semantic_vector__isnull=False, …)
if not baseline_clips: return Response({"error": "Not enough data to build baseline."}, status=400)
```
`AudioClip.tags` is written by KeyBERT keywords or hardcoded `["instrumental"]` (`tasks.py:292,296`) — free-form NLP output. `category` is a free-form `CharField` (`models.py:112`) that is a *different* field entirely. So selecting "comedy" matches essentially nothing and the user gets `400 Not enough data to build baseline.`

Note the error **is** surfaced (`client.ts:163-167` reads `data.error`; `OnboardingModal.tsx:51` shows `err.message`) — so this is a vocabulary mismatch, not a hidden failure.

**Minimal honest fix (needs a decision, §11):** the picker should be fed by real data (distinct `tags`, or `distinct category`) rather than an invented vocabulary.

---

### 23. `watch_time_ms` = media position — Medium-High (integrity)

```tsx
// frontend/src/stores/player.tsx:77-83   every ~6 s
interactionsAPI.logTelemetry(clip.id, { action_type: "view", watch_time_ms: Math.floor(cur * 1000) })
// :96-101  on pause
watch_time_ms: Math.floor(audio.currentTime * 1000)
// :169-172  on auto-advance
watch_time_ms: Math.floor(duration * 1000)
// :332-336  on manual skip
listen_duration_ms: Math.floor(currentTime * 1000), reel_position_ms: Math.floor(currentTime * 1000)
```
```python
# backend/app/services/interactions.py:282-283
clip_duration = max(clip.duration_ms, 1)
completion_rate = min(watch_time_ms / clip_duration, 1.0)
```
`watch_time_ms` is consumed as a **completion measurement**, and `completion_rate` is **30 % of the recommendation composite** (AGENTS.md, "Recommendation engine"). The client sends an absolute position where the server wants a quantity of watch time. Consequences, all client-originated:

- A user who seeks to 0:55 of a 60 s clip and pauses records `completion_rate ≈ 0.92` for 1 second of actual listening. Repeated, this is a ranking exploit.
- `handleAutoAdvance` fires from both the `0.99` `timeupdate` check and the `ended` event, so a completed clip can be reported twice at full `duration`.
- The 6 s heartbeat sends the *position*, so a 10-minute session emits `0.9, 1.8, 2.7, …` — monotonic, which the server will read as ever-increasing watch time.

Note the minors path is already gated (`views/interactions.py:65-72` → 403 on `is_minor`), so this is not a DPDP §9 issue — it is a metrics-integrity issue.

**Minimal honest fix:** send a **delta** (`now - lastSent`) and clamp to the interval, or rename the contract to `position_ms` server-side and compute a delta there. Needs a decision (§11) because it changes an API contract.

---

### 24. Profile category `<select>` — Medium

```tsx
// frontend/src/pages/Profile.tsx:467-478
<option value="comedy">comedy</option> … <option value="instrumental">instrumental</option>   // 6 options
```
`AudioClip.category` is free-form (`models.py:112`), `OnboardingModal` offers 8, `Explore` offers 7, `Upload` offers 6 — four different vocabularies in one app. A clip whose category is `tech` opens an edit modal where the `<select>` has **no matching option** (React renders it blank while `clipCategory` state holds `"tech"`). If the user touches the select at all, saving overwrites the real category with one of the six.

**Minimal honest fix:** drive the options from the distinct categories the backend actually returns, or use a free-text input.

---

### 25. Explore vector claims — Medium

```tsx
// frontend/src/pages/Explore.tsx:63-69
Browse audio reels clustered by semantic embeddings and acoustic vectors
… CLUSTER_INDEX: PGVECTOR_384D
// :97  (loading state)
Clustering acoustic embeddings...
```
`views/feed.py:207-222` only annotates `combined_distance` when `get_user_vectors(user)` returns **both** vectors; otherwise it silently falls back to `order_by('-engagement_velocity','-created_at')`. A cold-start user — precisely the population the Onboarding modal exists for — sees "PGVECTOR_384D" and "clustered by … acoustic vectors" over results that were ranked by engagement velocity with no vector involved. It is also imprecise when it *is* true: the ranking blends a 384-dim semantic and a **128-dim** acoustic vector (`models.py:149-150`), and the request is a nearest-neighbour query, not clustering.

**Minimal honest fix:** say "Ranked for you" or drop the badge; never assert a mechanism that may not have run.

---

### 26-27. Profile data the type promises but the API withholds — Medium

```ts
// frontend/src/types/echoflow.ts:33-43
export interface OwnProfile {
  id: number; username: string; email: string;   // <-- never sent
  profile_picture: string | null;                 // <-- unsigned; signed twin ignored
  …
}
```
```python
# backend/app/serializers.py:779-785
fields = ['id','username','profile_picture','profile_picture_url',
          'followers_count','following_count','uploads_count',
          'liked_clips','is_following','date_joined']     # no 'email'
```
`email` is typed non-optional so `tsc` is clean, and `Profile.tsx:169` renders `profile?.email` — a line that can never display. `auth.tsx:36` then persists `email: undefined` into `sessionStorage`. The **signed** `profile_picture_url` (`serializers.py:752-755`) is supplied and never read; `Profile.tsx:148` uses the raw field instead.

> Related doc/reality mismatch worth noting: `serializers.py:757-764` justifies `PublicProfileSerializer.get_is_following` with *"The Profile page has its own follow button hitting the same blind toggle, so it needs the same honest state."* **There is no follow button on `Profile.tsx` at all.** The backend comment describes a frontend affordance that does not exist — the exact failure class AGENTS.md's Working Agreement warns about.

---

### 28-31. Low severity

- `ReelCard.tsx:255-257` — idle bar heights `((idx * 17) % 65) + 20`; `player.tsx:138-164` — `Math.sin` envelope with **no `AnalyserNode`**. Both are honestly documented in source comments. Decoration, but the user cannot tell it from a spectrum analyser. If kept, mark `aria-hidden` and drop the accent colouring that implies signal.
- `App.tsx:30-33` — `catch {}` around the unread poll leaves the badge at its initial `0`, i.e. "you have no unread shares", on every failure. It also polls before login (`App.tsx:36-40` runs unconditionally on mount).
- `CommentSheet.tsx:114` — `user?.username === comment.author_username`; `author_id` is supplied (`serializers.py:521`) and ignored, so a renamed user loses Delete on their own comments.
- `CommentSheet.tsx:128` — `toLocaleTimeString` with no date; a month-old comment shows a bare time.

---

## 3. Fabricated values the BACKEND must supply (not fixable client-side)

| UI claim | Why the client cannot fix it | Backend work |
|---|---|---|
| `ReelCard.tsx:283` transcript | **No transcript field exists.** `grep transcript models.py serializers.py` → 0 hits. The worker computes it locally (`tasks.py:277`) and discards it | New `AudioClip.transcript` column + serializer field, or delete the UI |
| `ReelCard.tsx:294` similarity score | `combined_distance` is computed (`views/feed.py:210-215`) but not serialized | Add one field to `FeedClipSerializer.Meta.fields` |
| `Explore.tsx:159` listens | No view/play counter exists on any model | New counter + the counter-store path, or delete |
| `Profile.tsx:165` CREATOR badge | No creator concept on `User` | New field, or delete |
| `ReelCard.tsx:298` bitrate / ABR | No bitrate or ladder metadata is stored; there is no ladder | Expose ladder config, or delete |
| `Profile.tsx:169` email | `OwnProfileSerializer` omits `email` | Add it (own-profile only), or drop from the type |
| `OnboardingModal` tag vocabulary | `tags` is free-form KeyBERT output; no canonical list exists | Serve distinct values, or formalise a vocabulary |
| `player.tsx` `watch_time_ms` semantics | The contract is ambiguous; the client cannot know whether the server wants a delta or a position | Rename the field or document it, then fix the client |

---

## 4. Fabricated values the BACKEND ALREADY supplies (client-side fix only)

**Cheapest and highest-value class. No backend change, no migration, no test churn.**

| Field | Supplied at | Frontend ignores it at |
|---|---|---|
| `tags` | `serializers.py:409` | **nowhere** — `grep clip.tags` → 0 hits outside test fixtures |
| `combined_distance` | computed, `views/feed.py:210-215` | not serialized (see §3) |
| `Comment.reply_count` | `serializers.py:529-532` | `CommentSheet.tsx` never reads it |
| `Comment.author_id` | `serializers.py:521` | `CommentSheet.tsx:114` uses `username` instead |
| `ShareEvent.created_at` | `serializers.py:583` | `Inbox.tsx` renders no timestamp |
| `ShareEvent.clip_hls_url` | `serializers.py:582` | unused |
| `FeedResponse.next` | `views/feed.py:124` | `Feed.tsx` hardcodes `hasMore={false}` |
| `FeedResponse.queue_health` | `views/feed.py:125` | declared in the type, read by nothing |
| `liked_clips` true total | `serializers.py:831` `[:50]` | `Profile.tsx:251` shows the page length |
| `uploads_count` | `views/profile.py:26` | `Profile.tsx:239` uses `userClips.length` instead |
| `profile_picture_url` (signed) | `serializers.py:740,752-755` | `Profile.tsx:148` uses the unsigned field |
| `PublicProfile.is_following` | `serializers.py:741,757-764` | no follow button on public profiles |
| `/subscription/` limits | `views/subscription.py` | `Upload.tsx` hardcodes 100 MB / 300 s |
| `GET /clips/{id}/` → `status` | `views/content.py` (ModelViewSet) | `Upload.tsx:160` displays `clip_id`, never polls it |
| `FeedClip.skips`, `cover_image` | `serializers.py:397,398` | never rendered |

---

## 5. Blast radius

```
DEFAULT_PEERS          frontend/src/components/sharing/ShareModal.tsx:17,22,148
                       frontend/src/components/sharing/ShareModal.tsx:59,166   (send path)
                       backend  views/social.py:159-184  ->  models.ShareEvent, UserInteraction
                       blast radius = every share modal open; writes to arbitrary real users

sentUsers              ShareModal.tsx:26,56,60,149,167,174

192kbps / vectorStr / similarityScore / shortId / transcript
                       ReelCard.tsx:147-150,169,283,290,294,298
                       backend  tasks.py:44,104-113,360-367  (contradicted, not consumed)
                       blast radius = every feed card; read on every animation frame
                       (corroborated: docs/frontend/RECON-01-media-player.md:457)

Listens                Explore.tsx:159
                       backend  (no field exists)

CREATOR / ||0 / Date.now
                       Profile.tsx:164-166,172,207,213,219,70-74,262
                       Header.tsx:159-168  (same unsigned profile_picture)
                       blast radius = own profile + every public profile

Comment count/nesting  CommentSheet.tsx:84,113,114,128,37-41,107
                       client.ts:316-323  (parent param supported, never sent)
                       backend  _pagination.py:11, comments.py:52, serializers.py:521,529

Upload claims          Upload.tsx:30,42,125-127,163,165-167,217,273-276
                       client.ts:272-277   (clip_id returned and discarded)
                       backend  uploads.py:18-50, tasks.py:44,104-113,360-367

Pagination             Feed.tsx:164 -> ReelList.tsx:148-161
                       Explore.tsx:37-38
                       Profile.tsx:59,239,251
                       types/echoflow.ts:76-77
                       backend  _pagination.py:6, views/feed.py:123-127, serializers.py:831

handsFreeMode          player.tsx:43 (init) -> Header.tsx:137 (write) -> Feed.tsx:139 (label)
                       UNGUARDED: ReelList.tsx:98-106, player.tsx:86-88,104-106,166-178

watch_time_ms          player.tsx:79-82,97-100,169-172,332-336
                       backend  services/interactions.py:282-283 -> counter_store.add_completion
                       -> flush_counters_to_pg -> AudioClip.avg_completion_rate
                       -> 30% of the recommendation composite
                       blast radius = the ranking model itself

Tags vocabulary        OnboardingModal.tsx:11-20,46
                       backend  views/feed.py:264-275, tasks.py:292,296
                       also inconsistent with Explore.tsx:11-19, Upload.tsx:263-269,
                       Profile.tsx:472-478 (four vocabularies)

Test coverage          frontend/src/test/*.ts(x) — 48 cases across 5 files
                       grep for "Acoustic Vector|Similarity|192kbps|EF-|Sound travels|
                                Listens|CREATOR|CLUSTER_INDEX" in src/test/ -> only CREATOR_ID
                       (a test fixture constant). ZERO assertions on any fabricated value.
```

---

## 6. What a fix MUST preserve

1. **`reelCard.test.tsx` (8 cases)** — the follow-button behaviour, the optimistic-update + rollback contract, the in-flight double-tap guard, and the re-sync-on-prop-change effect. Those are correct and load-bearing. `reelCard.test.tsx:48` mocks `audioFrequencies: [0,0,0]`; removing the waveform must not require changing the mock's shape.
2. **Playback-token sequence** — `playClip` mints via `mediaAPI.getPlaybackToken` (`client.ts:430-447`, POST + `credentials:"include"`) *before* `loadSource`, and the `hls.js` `xhrSetup` sets `withCredentials` (`player.tsx:244-246`) with `crossOrigin="use-credentials"` on the native path (`:270`). No `setInterval`-driven progress may be introduced, and no "direct HLS" fallback (IMP-TODO.md).
3. **Error-status mapping** — `player.tsx:223-231` maps 409/403/404 correctly against `views/media.py:207,216,236,246`. Keep it.
4. **`useBackendHealth`'s two-probe rule** — `/health/` **and** `/ready/`, initial state `checking`, never green before a response. `backendHealth.test.tsx` (11 cases) pins all of it. Do not fold it into a fabricated indicator.
5. **`hasMore` contract with `ReelList`** — if pagination is implemented, `loadMore` must stay a separate observer from autoplay (`ReelList.tsx:59-73`) so fetching a page can never start a clip.
6. **48-test baseline, `tsc --noEmit` clean, `vite build` clean, 716 backend tests.** Additions must be additive.
7. **`ShareModal` must not gain a new "recent recipients" call** without a backend endpoint — there is none. The honest state is "search for a user".

---

## 7. Tests that would prove each fix

Every one of these must be written **against the unpatched code first and seen red** (AGENTS.md Working Agreement).

| Fix | Test |
|---|---|
| `DEFAULT_PEERS` gone | Render `ShareModal` with no `find-user` result; assert `POST /share/…/send-share/` is **never** called and no username is on screen. Then: run `find-user`, click Stream, assert exactly one call with the returned id |
| `sentUsers` re-keyed | Send to user 4 for clip A, reopen for clip B, assert the row is **not** labelled "Sent" |
| transcript deleted | Assert no node matches `/Sound travels without pixels/` on a rendered card |
| `192kbps` deleted | Assert the rendered card contains no `/kbps/i` and no `ABR` |
| vector/similarity deleted | Assert no `/Acoustic Vector/i` and no `/Similarity Score/i` |
| `CLIP_ID` fixed | Assert the displayed id, if any, is the literal `clip.id` |
| Explore Listens removed | Assert no `/Listens/i`; assert `duration_ms` **is** rendered (real value substituted) |
| CREATOR removed | Render a profile with `uploads_count: 0`; assert `/CREATOR/i` absent |
| `date_joined` fallback | Render with `profile = null`; assert today's date string is **not** present |
| `\|\| 0` stats | Reject `/clips/` with 500; assert `/0/` followers is **not** rendered and an error state is |
| Comment count | Clip with `comment_count: 340` and 20 fetched comments; assert the header reads 340, not 20 |
| Comment nesting | Parent with `reply_count: 3`; assert replies render nested, not as siblings |
| Comment load error | Reject `GET /comments/`; assert `/No comments yet/` is **not** shown |
| Inbox timestamp | Assert a relative time derived from `created_at` is rendered |
| `hasMore` / "All caught up" | Two feed pages available; assert "All caught up" is absent while `next` exists |
| Uploads tab label | `uploads_count: 42`, 10 clips returned; assert the tab reads 42 |
| Liked tab label | Backend returns exactly 50 of 50+; assert the label does not claim a total it cannot know |
| hands-free respected | Toggle off, fire clip end; assert `nextClip("auto")` is **not** called |
| Upload no-false-stage | Mock `POST /clips/` → 202; assert no text claims a worker is running and that `onUploadSuccess` is not auto-fired |
| Upload limits | Mock `GET /subscription/` returning `{limits:{max_upload_mb:10}}`; assert 10 is shown, not 100 |
| `watch_time_ms` delta | Advance 2 s, assert the emitted `watch_time_ms <= elapsed`, not `position*1000` |
| Tags rendered | `tags: ["instrumental"]`; assert the tag is on screen (proves the real value is consumed) |

---

## 8. Recommended fix order (sequential, lowest blast radius first)

1. **`ShareModal` — delete `DEFAULT_PEERS` + the `:148` branch.** ~6 lines removed, one file, no prop changes, no API change. Stops live data corruption. Ship alone with its two tests. *Nothing else in this report matters as much as this.*
2. **`ShareModal` — re-key `sentUsers` by `(clipId, recipientId)`.** Same file, follows directly from #1.
3. **`ReelCard` — delete `:147-150`, `:169`, `:283`, `:286-300`.** One contiguous block plus one line. No backend change. Render `tags` and `duration_ms` in the freed space.
4. **`Explore` — delete `:159` and the `:63-69`/`:97` vector copy.** Two lines, one file. Substitute `duration_ms`/`tags`.
5. **`Profile` — delete the `CREATOR` badge; replace `|| 0` with skeleton/error; `date_joined` → em dash; add the `catch` branch.** One file, four edits, all additive. This is the highest *user-trust* density per line in the report.
6. **`Inbox` — render `created_at`.** One line, no other change.
7. **`CommentSheet` — header reads `clip.comment_count`; add an error branch; nest on `parent` and render `reply_count`; switch `isAuthor` to `author_id`.** One file; `client.ts` needs no change (`parent` is already supported).
8. **`Upload` — delete the pipeline-spec and worker-dispatched copy; poll `GET /clips/{id}/` or stop claiming progress; read real limits from `GET /subscription/`.** One file, no backend change.
9. **Pagination: `Feed.tsx` `hasMore`, `Explore` `next`, `Profile` tab labels.** Three small, independent edits; all backend data already exists.
10. **`handsFreeMode` — add the guard or delete the toggle.** 3 lines either way. Do not leave it as a string.
11. **`watch_time_ms` — needs the §11 decision first.** Touches an API contract and the ranking model; do not bundle it with a UI commit.
12. **Onboarding vocabulary + category selects — needs the §11 decision.** Unified across `OnboardingModal`/`Explore`/`Upload`/`Profile`.

---

## 9. Deliberately NOT fixed for MVP — with reasoning

- **The idle/playing waveform bars** (`ReelCard.tsx:252-279`, `player.tsx:138-164`). Fabrication, but the source comments are accurate and it is pure decoration with no decision attached. Cost of removal (visual emptiness) exceeds cost of retention, *provided* it is marked `aria-hidden` and the accent colouring that implies signal is dropped. Fix when the card is redesigned.
- **`MiniPlayer`'s 5-bar visualiser** (`MiniPlayer.tsx:38-46`) — same reasoning, smaller surface.
- **The synthetic "demo voice" generator** (`Upload.tsx:62-102`). It is honestly labelled "Synthesize 15s Demo Voice Clip **For Testing**". It does upload a real sine tone to the DB and will send it to Whisper, so it should be dev-gated, but the label is not a lie.
- **Unread-count `|| 0` on poll failure** (`App.tsx:30-33`). Cosmetic, self-correcting within 30 s.
- **`CommentSheet` time-only timestamps** (`CommentSheet.tsx:128`). Real defect, trivially low stakes.
- **Anything requiring a new backend field** (transcript, listens, bitrate, `is_creator`, `email`) is listed in §3 and explicitly **not** in the fix order. The honest MVP action is to **delete the claim**, which needs no approval. Adding the fields is a separate, owner-gated decision.

---

## 10. Disconfirmations

Claims from `docs/frontend_rebuild_plan.md`, `docs/FRONTEND-REQUIREMENTS.md`, and the other recon reports that are **wrong or imprecise**:

1. **P0-7 "The Follow button is destructively wrong… there is no `is_following` on `FeedClipSerializer` and no follow-status endpoint anywhere"** (`frontend_rebuild_plan.md:58`, citing `serializers.py:309-364`, `ReelCard.tsx:56`) — **FIXED / now WRONG.** `is_following` exists (`serializers.py:383`, `436-461`) and is consumed with hydration + rollback + an in-flight guard (`ReelCard.tsx:56,76-78,101-124`), pinned by 8 tests. Cited line numbers are stale (`serializers.py` moved to 374-461; `ReelCard.tsx:56` is now `isFollowing` init, not a hardcoded `false`).

2. **"A real `transcript` field exists"** (`frontend_rebuild_plan.md:68`) — **WRONG.** `grep -n transcript backend/app/models.py backend/app/serializers.py` → **0 hits.** The transcript is a worker-local variable (`tasks.py:277`). The proposed fix ("render the real transcript") is not a client-side rewire; it needs a new column. **My §3 upgrades this item's cost.**

3. **"`HLS_BUCKETS` is server-side config"** (`frontend_rebuild_plan.md:69`) — **WRONG.** `HLS_BUCKETS` is `backend/app/metrics.py:132`, a **Prometheus histogram bucket tuple in seconds** `(1.0, 5.0, …, 600.0)`, unrelated to bitrate. There is no bitrate config anywhere; the encode is a single hardcoded `128k` variant (`tasks.py:360-367`).

4. **`FRONTEND-REQUIREMENTS.md:1710` — "Remove `clip.tags.slice(0,4)`. `FeedClipSerializer` does not include `tags`."** — **now STALE.** `tags` was added to `FeedClipSerializer.Meta.fields` (`serializers.py:409`, A2 / `3b3f840`). It is now fetched and rendered nowhere, which is the opposite problem.

5. **`FRONTEND-REQUIREMENTS.md:944` — Inbox has "tabs (messages / activity — activity is demo data, no backend)"** — **already removed.** The current `Inbox.tsx` has no tabs and no demo data. The remaining Inbox defect is the inverse: the *real* `created_at` is unused.

6. **`FRONTEND-REQUIREMENTS.md:940-941` — "`markRead` uses PATCH (`pages/Inbox.tsx:31`) but backend is POST. Will return 405. **Status: Broken.**"** — **already FIXED.** `client.ts:367-371` uses `POST` and cites `views/social.py:92-95` correctly. That same line of the requirements doc is the only reason I expected an Inbox status bug; there is none.

7. **Prior-audit line numbers drifted** for four ReelCard citations: transcript `:238`→**283**, bitrate `:253`→**298**, `shortId` `:138`→**148**, vector math `:116-119,210-212,244-253`→**149-150, 288-299**. `Explore.tsx:159`, `Profile.tsx:164-166`, and `Upload.tsx:163,274-275` are still accurate. `COMPLETION_PLAN.md:6-8` acknowledges this drift for the plan; the audit itself does not.

8. **The mission brief's suspicions, checked and cleared:**
   - *"Inbox.tsx — failed-state rollback"* — **not a defect.** `Inbox.tsx:37-47` sets `is_read: true` only **after** `await markRead` resolves; the `catch` only `console.warn`s. Nothing is optimistically set, so there is nothing to roll back. The real Inbox issue is the *unused* `created_at`.
   - *"hardcoded pagination" in Explore* — there is no hardcoded page number. There is an **ignored cursor** (`next` discarded at `Explore.tsx:37-38`), which is a different defect.
   - *"Upload.tsx — progress/state claims"* — no fake progress bar and no `setInterval`. The fabrication is the pipeline *narrative* (`:163`, `:275`) and the unconditional 2.5 s redirect (`:125-127`).

9. **Claims I verified as already correct** (no action, listed so they are not re-audited): `POST /clips/` really is `202` (`views/content.py:222`) → `Upload.tsx:158` honest; `ProfileUpdateSerializer.MAX_SIZE = 5MB` (`serializers.py:861`) → `Profile.tsx:414` "Max 5MB" honest; the `isDegraded` banner (`Feed.tsx:130`) only renders on the `views/feed.py:148-153` path where trending reels genuinely are served → honest; the `Header` health indicator is a real two-probe poll, not the old fabricated "Workers Active"; `Profile.tsx:294`'s `likes/comment_count/shares` are real (`/profile/{id}/clips/` uses `FeedClipSerializer`, `views/profile.py:77`); `player.tsx:223-231`'s 409/403/404 mapping matches `views/media.py:207,216,236,246`; `?category=all` is a real no-op sentinel (`views/feed.py:180-181`), so "All Hubs" is not broken.

10. **A backend comment that describes a frontend that does not exist** — `serializers.py:760-762` justifies `PublicProfileSerializer.get_is_following` with *"The Profile page has its own follow button hitting the same blind toggle."* `Profile.tsx` has **no follow button at all**. Same failure class as the `CORS_URLS_REGEX` and `ErrorBoundary.tsx:28` incidents in AGENTS.md: a comment naming an affordance with no referent.

11. **Parallel-agent territory, reported not judged:** `stores/auth.tsx` and `api/client.ts` are under active auth/session work; `NetworkBanner`/`BottomNav`/`ErrorBoundary`/`SessionAnnouncer` under a11y and error-resilience work. Several of these files carry long, accurate, recently-added comments that read as mid-flight or just-landed. I have made **no** finding that depends on whether their in-progress edits land, and no file was modified.

---

## 11. Open questions for the owner

1. **`watch_time_ms` — delta or position?** The server computes `completion_rate = min(watch_time_ms / clip_duration, 1.0)` (`interactions.py:283`) and that is 30 % of the ranking composite. The client sends absolute position. Three options: (a) client sends a clamped delta — client-only fix, no contract change; (b) server renames to `position_ms` and derives the delta — breaks any other client; (c) leave it. **I recommend (a).** It is a decision because it changes what "watch time" means in the ranking model, and I will not pick it unilaterally.
2. **Should the fabricated ReelCard telemetry be deleted or backfilled with real values?** `tags` and `duration_ms` are free. A real similarity score needs one serializer field (`combined_distance` is already computed and discarded at `views/feed.py:210-215`). Is a "match %" worth surfacing to users at all, or is the honest answer to delete the row?
3. **Free-tier limits: fix the copy or fix the enforcement?** The 60 s / HD caps advertised by `GET /subscription/` are enforced nowhere (`docs/EXPLAIN/decisions/2026-09-29-unenforced-subscription-limits.md`, still OPEN). Options: (a) frontend reads real limits from `/subscription/` and stops claiming 300 s is universal; (b) backend enforces the advertised caps. (b) was previously declined on the condition it not require backend changes — that condition still holds, so (a) is the available path.
4. **Category/tag vocabulary — who owns it?** Four different lists exist in one app (`OnboardingModal` 8, `Explore` 7, `Upload` 6, `Profile` 6) and none matches what the backend actually stores (free-form KeyBERT keywords). Should there be one canonical list, served by the backend? Until then the Profile edit-`select` can silently rewrite a real category.
5. **Does a user need a "recent recipients" list in the share modal?** The honest replacement for `DEFAULT_PEERS` is an empty state plus search. A real recipient list would need a new endpoint (`GET /share/recent-recipients/`) — out of scope for a data-truthfulness pass, but it is the only way that screen gets more useful.
6. **Is `uploads_count` the right number for "Audio Reels"?** It is `Count('audio_clips', distinct=True)` (`views/profile.py:26`) — **all** rows, including `status='processing'`, unmoderated, and moderation-rejected clips. A user with 3 failed uploads sees "3 Audio Reels". Should it filter to `status='ready' and moderation_approved=True` to match what `/profile/{id}/clips/` returns (`views/profile.py:68`)?
7. **`liked_clips` is capped at 50** (`serializers.py:831`). Should the cap be lifted, or should the frontend stop presenting the array length as a count?
</task_result>
</task>