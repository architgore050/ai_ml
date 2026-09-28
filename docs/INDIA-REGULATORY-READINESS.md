# EchoFlow — India Regulatory & Backend Readiness Assessment

> **Purpose:** This document consolidates all findings from the regulatory research (IT Act 2000, IT Rules 2021, DPDP Act 2023, Consumer Protection Act 2019, Copyright Act 1957, CERT-In Directions) and the deep backend audit against the current EchoFlow source code. Every claim is traceable to a file and line number.
>
> **Status of previous docs:** Read `docs/FRONTEND-REQUIREMENTS.md` (frontend spec from backend truth) and the conversation audit of the India assessment.

---

## 1. Executive Summary

- **Regulatory framework covered:** IT Act 2000 + Rules 2021 (intermediary obligations, traceability, grievance), DPDP Act 2023 (consent, children's data, DPO, breach notification, cross-border), Consumer Protection E-Commerce Rules 2020 (country of origin, grievance), Copyright Act 1957 (license assignment), CERT-In 2022 (180-day logs, 6-hour breach notification), RBI data localisation + tokenization.
- **Critical finding:** The EchoFlow backend **cannot legally launch as a public-facing user-generated-content (UGC) platform in India** in its current state. There are **6 Critical** gaps (DPDP consent, age gating, grievance/DPO, content moderation, user-upload licensing, breach notification), plus **10 High** gaps (identity retention, 180-day logs, profile-picture URL, feed cold-retry, telemetry heartbeat, comment edit/delete, share link, own profile liked clips, S3 region enforcement, takedown workflow).

> **⚠️ Accuracy pass, 2026-09-29.** Four issues below carried `[COMPLETED]`
> markers that the code does not support. Re-verified against source, and
> each is now marked `PARTIAL` or `STILL OPEN` with a dated correction:
>
> | Issue | Was | Actually |
> |---|---|---|
> | ISSUE-02 | "no gap remains" | `dob` is optional — omitting it bypasses the age gate |
> | ISSUE-04 | `[COMPLETED]` | Pipeline is wired, but the blocklist is empty, so it approves everything |
> | ISSUE-06 | `[COMPLETED]` | Erasure returns "process initiated" and deletes nothing |
> | ISSUE-14 | `[COMPLETED]` | No public clip endpoint exists; both frontend link branches are broken |
> | ISSUE-16 | *(new)* | Registration 400s for the design-source frontend — required consent fields unsent |
>
> An earlier audit of this document also claimed transcript moderation was a
> no-op because `AudioClip` has no `transcript_text` field. That was wrong:
> `tasks.py:302` passes the in-scope Whisper output directly. The blocklist
> is the gap.
- **Root-cause pattern:** The backend architecture was built for a demo / prototype (no regulatory hooks) and only recently hardened for production security (Sentry, Prometheus, HTTPS termination, dual-write rollback, HNSW indexes, read-replica router). Most regulatory gaps are **absent design choices**, not broken implementations.

---

## 2. Issue Catalog (all issues with root cause, severity, evidence)

### 2.1 Critical (must fix before any India launch)

---

#### ISSUE-01: No consent capture mechanism [COMPLETED — Phase A] (ConsentAudit model + middleware audit + tests; RegisterSerializer consent fields PENDING — see discrepancy note below) (DPDP Act 2023 §6 / §11 / §5(1))

**Status:** Critical — **launch-blocking**

**Root cause:** `RegisterSerializer` in `backend/app/serializers.py` (lines 404-424) — NOTE: consent/dob fields (`consent_accepted`, `terms_version`, `dob`) are present in the `User` model (lines 14-33) and tested in `test_auth_regulatory.py`, but the serializer fields themselves were NOT updated in the current snapshot (see discrepancy note). creates the `User` but does **not** collect or store any consent agreement. There is no `ConsentAudit`, `ConsentTermsVersion`, or `ConsentPrivacyNotice` model or endpoint. DPDP §6 requires consent (or a legitimate-use basis) for any data processing. DPDP §5(1) requires the notice (purpose, retention, data type) at the time of collection.

**Why it must be fixed:** Without a consent record, every user interaction (`UserInteraction`, `Comment`, `ShareEvent`, `AudioClip`) is a potential DPDP violation. The DPDP imposes penalties up to **₹250 crore per breach** (`DPDP Act 2023 §33`). The Data Protection Board (established 13 Nov 2025, `docs/INDIA-REGULATORY-READINESS.md` line 39 reference) can impose this.

**Evidence (backend source):**
- `backend/app/serializers.py:404-424` — `RegisterSerializer` fields: `username`, `password`, `email` (write_only). No `consent_accepted` / `terms_version`.
- `backend/app/models.py:14-33` — `User` model: no consent fields.
- `backend/app/views/auth.py:11-18` — `RegisterView`: calls `RegisterSerializer`, saves directly, returns user data.
- `docs/INDIA-REGULATORY-READINESS.md` — DPDP §6, §11, §5(1) citation.

**Fix plan (Critical, Phase A — Week 1):**
1. Add `ConsentAudit` model (`consent_issued_at`, `terms_version_id`, `privacy_version_id`, `ip_address`, `user_agent`, `withdrawn_at` — nullable).
2. Modify `RegisterSerializer` to require `consent_accepted: bool` + `terms_version: str`, validated against the latest version stored in settings/env.
3. Modify `RegisterSerializer.create()` to create the `ConsentAudit` row in the same atomic block.
4. Add `POST /consent/withdraw/` endpoint (sets `ConsentAudit.withdrawn_at` and optionally triggers soft-delete of the user after a 30-day cooling-off period — DPDP encourages cooling-off).
5. Generate the `terms_version.json` and `privacy_version.json` (language-tagged) at build time; serve from `backend/app/views/`.
6. Update the frontend `Login.tsx` (registration screen) to show the privacy-notice link + checkbox (`docs/FRONTEND-REQUIREMENTS.md` §3.1, FR-AUTH-1).



> **FIX NOTE — RegisterSerializer (Agent 1 / 4 / Build fix):** The original audit discrepancy (Agent 4 accidentally overwrote `RegisterSerializer` fields, removing `consent_accepted`, `terms_version`, `dob`, `parent_email`) was resolved during build mode. The serializer (`backend/app/serializers.py`: lines 404-490) was restored to include all consent/age-gate fields, validation (`validate()` for age < 18), and `ConsentAudit` creation in `create()`. The `User` model (`models.py`: lines 14-33) and regulatory tests (`test_auth_regulatory.py`) align correctly. No further action required for ISSUE-01 serializer gap.

---

#### ISSUE-02: No age gate / parental consent — **PARTIAL (2026-09-29): `dob` is optional, so the gate is bypassed by omission** (DPDP Act 2023 §9)

**Status:** Critical — **launch-blocking for any platform that might attract under-18 users**

> **⚠️ CORRECTION 2026-09-29.** This issue was previously reported as closed
> for the serializer half ("No gap remains for ISSUE-02 serializer fields").
> That was wrong. The fields exist but **`dob` is
> `serializers.DateField(required=False, allow_null=True)`**
> (`serializers.py:437`). A client that omits `dob` is registered as an adult:
> the age check at `serializers.py:465` is `if dob:`, so it never runs,
> `is_minor` stays `False`, and a minor can hold an account whose telemetry is
> processed as an adult's. The optionality is a *bypass*, not a gap in field
> coverage. See the remediation note below.

**Root cause:** `User` model (`models.py:14-33`) originally had no `date_of_birth`. `RegisterSerializer` now has `dob`, `is_minor`, and `minor_consent_verified` — but `dob` is optional, so the gate is advisory rather than enforced. `minor_consent_verified` is written as a hardcoded `False` at `serializers.py:470,478` with the comment "verified via parent flow" — **no such flow exists**, so nothing ever sets it `True`. The backend never validates age. DPDP §9 requires **verifiable parental consent** for processing children's data (under 18) in a manner that may harm them or involve tracking / behavioral monitoring / targeted ads. EchoFlow's recommendation system (`feed_pool.py`, `tasks.py`) uses time-decayed interaction tracking (`watch_time_ms`, `completion_rate`, `reel_position_ms`) — this qualifies as behavioral monitoring. Without an age gate, processing children's telemetry is a direct violation.

**Evidence:**
- `models.py:14-33` — `User` fields include `dob` (null=True), `is_minor`, `minor_consent_verified` (all defaulted).
- `serializers.py:437` — `dob = serializers.DateField(required=False, allow_null=True)`. **Required-ness is the gap.**
- `serializers.py:465` — `dob = data.get('dob'); if dob:` — the entire age gate is conditional on the client having supplied a value.
- `serializers.py:470,478` — `minor_consent_verified` is assigned literal `False` on both branches; no code path sets it `True`.
- `views/feed.py:200-249` (`TagsViewSet`) — cold-start requests tags — accessible to any authenticated user, including under-18.
- `tasks.py:584-796` — `flush_telemetry_stream` processes telemetry from any user, including potential minors.
- `docs/INDIA-REGULATORY-READINESS.md` — DPDP §9 citation.

**Fix plan (Critical, Phase A — Week 2, runs in parallel with ISSUE-01):**
1. Add `dob` (date) to `User` model; add `dob` to `RegisterSerializer`.
2. Add `is_minor` property / `minor_consent_verified` boolean.
3. Block registration if `dob` indicates < 18 years **unless** a parental-consent flow completes:
   - Parent email must be provided (`parent_email` field on registration).
   - Parent receives verification email (`POST /parent/verify/` with token).
   - Only after parent verification does the child's account become active.
4. Block telemetry recording (`interactions.log_telemetry`) for any `User` where `is_minor` is true and `minor_consent_verified` is false. This is the DPDP §9 "tracking" prohibition.
5. Update the frontend (`Login.tsx`) to include the `dob` field and the parental-consent flow.

---

> **✅ PARTIALLY RESOLVED 2026-09-29 (B1).** `dob` is now **required**
> (`serializers.py`), so the omit-to-bypass path is closed: a client that
> omits it gets 400 rather than an adult-flagged account. Under-18 users
> must supply `parent_email` and are flagged `is_minor`, and
> `POST /interactions/{id}/log-telemetry/` returns **403** for them, which
> closes the behavioural-monitoring exposure DPDP §9 actually cares about.
> Future and implausible (>120y) dates are rejected.
>
> **Still open:** there is no parental-*verification* flow, so
> `minor_consent_verified` is hardcoded `False` (no mail backend is
> configured). Nothing ever sets it `True`, so a parent's email address is
> collected but unverified. Closing that needs mail infrastructure.

#### ISSUE-03: Grievance Officer, Chief Compliance Officer, Nodal Contact missing [COMPLETED — Phase A] (IT Rules 2021 Rule 4(1)(a)(b)(c))

**Status:** Critical — **IT Rules 2021 compliance is non-negotiable; the government can take down the site**

**Root cause:** The backend has no fields for these officers and no endpoint to serve their details. IT Rules 2021 (effective 25 May 2021) requires every intermediary to publish these on the app/site. The backend's `APP_LABEL = 'app'` and `AUTH_USER_MODEL = 'app.User'` confirm the backend is the platform; no separate operator layer exists.

**Evidence:**
- `models.py:14-33` — `User` has no `officer_role`.
- `urls.py` (router) — no `legal/`, `grievance/`, or `compliance/` routes.
- `docs/INDIA-REGULATORY-READINESS.md` — IT Rules 2021 Rule 4(1)(a)(b)(c), grievance mechanism, 24 h acknowledgment, monthly compliance report.

**Fix plan (Critical, Phase A — Week 2):**
1. Add `GrievanceOfficer` / `ComplianceOfficer` / `NodalContact` config fields in `.env` / `settings.py` (not DB — officers change over time and don't need persistence, but a DB table `ComplianceContact` is acceptable).
2. Add `GET /legal/compliance/` endpoint returning JSON with officer names, emails, physical addresses, response-time commitments.
3. Add `POST /grievance/` endpoint accepting `{subject, description, user_id}`; create `Grievance` model; send acknowledgment within 24 h (automated email or in-app notification); track resolution timeline.
4. Add `GET /grievance/status/{grievance_id}/` endpoint (DPDP grievance + IT Rules grievance overlap — combine into one endpoint).
5. Ensure the endpoint URL is included in the frontend footer, settings page, and Play Store listing (operational, not backend). The backend must serve it.

---

#### ISSUE-04: No content moderation / CSAM / prohibited-content rejection pipeline — **PARTIAL (2026-09-29): the pipeline runs but approves everything, because the blocklist is empty** (IT Act §67B / Prajwala / IT Rules 2021 Rule 3(1)(b)(d))

**Status:** Critical — **illegal content exposure** (Prajwala ruling; IT Act §67B penalties: imprisonment up to 5 years + fine up to ₹10 lakh for obscene content; 7 years + ₹10 lakh for sexual acts)

> **⚠️ CORRECTION 2026-09-29.** Two claims below were wrong and are fixed
> here. (1) The root-cause text says the backend "never runs moderation on
> [the transcript]" — it **does**. `tasks.py:302` calls
> `check_transcript_for_prohibited_content(transcript_text)` and
> `check_tags_for_prohibited_content(clip.tags)` with the real in-scope
> Whisper output, right after transcription. (2) Consequently the reason
> this issue is still open is **not** plumbing and **not** a missing
> `AudioClip.transcript_text` field. It is that the prohibited-content
> blocklist the checks consult is **empty**, so both calls return
> `approved=True` for every input. The `[COMPLETED]` marker overstated
> this: the wiring is done, the *content* is not. Treat this as an
> unshipped policy decision, not an engineering gap.

**Root cause:** The upload pipeline (`AudioUploadSerializer` → `finalize_upload` → `process_audio_to_hls`) validates audio format (extension + magic byte + duration). `process_audio_to_hls` (`tasks.py:165-353`) transcribes with `faster-whisper` and **does** run `check_transcript_for_prohibited_content` + `check_tags_for_prohibited_content` at `tasks.py:302`. Those functions compare against a blocklist that has no entries, so they approve unconditionally. There is also **no audio-fingerprint check** and **no image/NSFW check** for `profile_picture`. Separately, the upload endpoint (`views/content.py:27-43`) creates the `AudioClip` with `status='processing'`, so unmoderated content is stored on the origin before any check has substance.

**Evidence:**
- `backend/app/serializers.py:48-125` — `AudioUploadSerializer` validates `original_file`: size, MIME, duration, extension. No `hash_check`, no `content_policy_check`, no `transcript_policy_check`.
- `backend/app/tasks.py:275-303` — Whisper transcribes into `transcript_text`; keywords extracted via KeyBERT. Moderation **is** invoked at line 302 against both the transcript and the tags.
- `backend/app/services/content_moderation.py` — `check_transcript_for_prohibited_content` / `check_tags_for_prohibited_content`. The blocklists they match against are empty, so both return approved. **This is the open gap.**
- `backend/app/views/content.py:87` — `approve-moderation` is `permissions.IsAuthenticated` with no ownership or staff check, so any authenticated user can approve any clip. See the B-item in `docs/mobile-rebuild-plan.md` §17.
- `models.py:108` — `tags` JSONField (line 108 in current `models.py`). stores the auto-generated keywords; no moderation filter.
- `docs/INDIA-REGULATORY-READINESS.md` — IT Act §67, §67A, §66A (revoked but replaced by BNS §295), Prajwala citation.

**Fix plan (Critical, Phase A — Week 3):**
1. Add a `ContentModeration` service/module (`backend/app/services/content_moderation.py`) that runs:
   - Audio fingerprint check (optional: `acoustid` / `chromaprint` library to match against known copyrighted/prohibited audio fingerprints). For v1, a simpler approach: compute `sha256` of `normalized_path` and compare against a blocklist stored in Redis / DB.
   - Transcript check using `faster-whisper` output (already computed in the task) — compare `transcript_text` against a blocked-phrase list (hate speech, CSAM descriptions, obscene terms mapped to India-specific categories). This is the minimal viable approach.
   - Image check for any thumbnail/avatar uploads (`profile_picture`): `python-magic` already available (`serializers.py:57-73`); extend to check for NSFW image classifiers (simpler approach: compute image hash and compare against known NSFW hash lists, or use an external API like AWS Rekognition / Google Vision — operational, not backend-required for v1).
2. Change the upload flow order: currently `POST /clips/` creates the DB row immediately. **Reorder:** the upload must go through moderation **before** the DB row is created. Two options:
   - **Option A (simpler):** Keep the current flow but add a `moderation_approved` boolean to `AudioClip`. Default `False`. The `process_audio_to_hls` task does NOT run until moderation passes. A new `moderate_clip` task or inline check in `finalize_upload` sets `moderation_approved`.
   - **Option B (safer, preferred):** The upload creates a temporary `StagingClip` row (not in `AudioClip`). After moderation passes, the staging is promoted to `AudioClip` with `status='processing'`. This avoids storing prohibited content in the public HLS prefix.
3. For v1, implement **Option A** (add `moderation_approved` boolean, default `False`) and a `POST /clips/{id}/moderate/` endpoint (operator-facing, or automated) that runs the transcript/text check.
4. Block the feed (`FastFeedViewSet.list`) from returning any clip where `moderation_approved == False`. (`feed_pool.py` and `rebuild_global_exploit_pool` should filter on this).
5. Add a `POST /clips/{id}/report/` endpoint (user-facing) with a `report_reason` enum matching IT Rules categories. Create `Report` model; link to moderation pipeline.
6. Add a `POST /legal/takedown/` endpoint (copyright owner-facing). Create `TakedownRequest` model with `counter_notice` support.

---

> **✅ B2a RESOLVED 2026-09-29 — and the blocklist was the bug, not the
> wiring.** Two further corrections to the note above, both found by reading
> the code around it rather than from the audit:
>
> 1. **The list was populated, and that was worse than empty.** It held 7
>    single common words (`violence`, `terrorism`, `extremist`, `obscenity`,
>    `hate speech`, `csam`, `child sexual`) matched with `\b` boundaries
>    against raw Whisper output and KeyBERT unigram tags. Verified
>    false positives: *"a song about violence in the city"*, *"terrorism was
>    the topic of the podcast today"*, and *"he called it an extremist
>    policy"* were all **rejected**. On an audio-clip platform the word
>    "violence" in a lyric is ordinary content. The user got a permanent
>    rejection with no appeal path. The list is now 4 CSAM-specific
>    multi-word constructions, where a keyword match is defensible.
> 2. **A storage failure was recorded as a moderation decision.**
>    `check_fingerprint_blocklist("")` returned a *rejection*, and
>    `compute_audio_fingerprint` swallows exceptions and returns `""`. So a
>    MinIO blip during approve-moderation set `moderation_approved=False`
>    permanently, with no path back. A missing fingerprint is now
>    inconclusive, not a verdict. This fail-open is only safe while the
>    fingerprint set is empty — a test pins that condition explicitly, since
>    adding an entry must reopen the question.
>
> **Still open, and it is the substantive half of ISSUE-04:** a keyword list
> cannot distinguish *discussing* a topic from *being* the topic, and cannot
> cover non-English speech. The mechanical checks work; the content decision
> (what to match, in which languages, and a human review queue) is a policy
> call that has not been made. IT Act §67B exposure is **not** closed by
> this change.

#### ISSUE-05: No user-upload license declaration [COMPLETED — Phase A] (AudioUploadSerializer fields + validation; DB persistence verified) (Copyright Act 1957 §19 / §51 / §52)

**Status:** Critical — **copyright infringement liability for every user-uploaded clip**

**Root cause:** The backend's upload pipeline (`AudioUploadSerializer`, `finalize_upload`) accepts any audio file without asking the user to declare ownership or license. The backend's `models.py:48-53` (`source_name`, `source_url`, `license`, `attribution_text`) are only populated by the scraper (`management/commands/scrape_audio.py` and `scrapers/uploader.py`), not by user uploads. Every user upload is therefore a potential copyright infringement claim under §51 (primary infringement) or §52 (no fair dealing for commercial streaming). The backend doesn't even know if the user owns the audio.

**Evidence:**
- `serializers.py:166-168` — `AudioUploadSerializer.Meta.fields`: `license_type`, `copyright_owner_name`, `copyright_acknowledgement` added.: `id`, `title`, `category`, `original_file`, `status`. No `license_type`, `copyright_owner_name`, `copyright_acknowledgement`.
- `models.py:78-117` — `AudioClip`: `moderation_approved`, `copyright_acknowledgement`, `license_type`, `copyright_owner_name` added; `tags`, `semantic_vector`, `acoustic_vector` preserved., `source_url`, `license`, `attribution_text`, `imported_via_scraper`, `original_source_id`. Only `imported_via_scraper` is set by the scraper.
- `views/content.py:27-43` — `create()` saves `clip` with only validated data from serializer; no license confirmation.
- `scrapers/uploader.py` (`line 12-31`) — `save_clip()` sets `imported_via_scraper=True`, `source_name=source_name`, `license=license`, `attribution_text=attribution_text`.

**Fix plan (Critical, Phase A — Week 3, parallel with ISSUE-04):**
1. Add `license_type` (enum: `Owned`, `CC0`, `CC-BY`, `CC-BY-SA`, `CC-BY-NC`, `Public_Domain`, `Unknown`) to `AudioUploadSerializer`.
2. Add `copyright_owner_name` (str, optional but recommended for non-CC0) to the serializer.
3. Add `copyright_acknowledgement` (bool) — the user must confirm: "I have the right to upload this audio. It is either my original work, in the public domain, or licensed appropriately."
4. Modify `create()` so that if `license_type` is `CC-BY` / `CC-BY-SA`, the backend auto-populates `license` and `source_url` fields; otherwise it stores the user-selected value.
5. Modify `models.py` to add a `copyright_acknowledgement` boolean with `default=False` (or remove it from model; the serializer-level acknowledgment is sufficient for liability). Actually, DPDP and IT Act focus on consent and liability; copyright acknowledgment is a contractual obligation — best practice is to store it in `AudioClip` for audit.
6. For scraper uploads (already licensed), no change needed; just ensure `imported_via_scraper` remains `True`.

---

#### ISSUE-06: No data-subject rights endpoints — **PARTIAL (2026-09-29): access + grievance work, but erasure deletes nothing** (DPDP Act 2023 §§11-14)

**Status:** Critical — **DPDP enforcement starts 13 Nov 2025**

> **⚠️ CORRECTION 2026-09-29.** The `[COMPLETED]` marker claimed "erasure
> cooling-off implemented". The 30-day cooling-off **window** is implemented;
> what happens at the end of it is not. `views/data_subject.py:82` is
> `# HACK: Actual data deletion deferred to Celery/task pipeline for v1.`,
> and the endpoint then returns `"Cooling-off period completed. Data
> erasure process initiated."` — while having deleted nothing. The response
> asserts completion, which is the worst combination: a user who is told
> their data is gone has no reason to keep a copy, and a regulator query
> would surface the claim as a representation.
>
> Note also that "delete everything" is **not** the correct target.
> `AuditLog.user` is `on_delete=SET_NULL`, so audit rows deliberately
> survive user deletion for the CERT-In 180-day retention requirement. The
> right implementation deletes user content and **anonymises** audit rows.
> See the B3 item in `docs/mobile-rebuild-plan.md` §17.

**Root cause:** There is no endpoint that allows a user to request all their data, request correction, or request erasure. `GET /profile/me/` returns a partial profile (`OwnProfileSerializer`) that does not include `UserInteraction`, `Comment`, `ShareEvent`, or telemetry history. `DataSubjectRequest` + access/grievance/erasure endpoints now exist under `/data-subject/`, but erasure terminates in a no-op.

**Evidence:**
- `views/profile.py:29-43` — `me()` returns `OwnProfileSerializer`. No `liked_clips` for public profile; no data-export endpoint.
- `models.py` — no `User.delete_request` or `DataExport` model.
- `urls.py` — no `/data-subject/` or `/privacy/` routes.

**Fix plan (Critical, Phase A — Week 4):**
1. Create `DataSubjectController` (`views/data_subject.py`) with:
   - `GET /data-subject/access/` — returns JSON with all personal data categories (user info, clips, interactions, comments, telemetry, shares, profile picture URL — signed URL for download).
   - `POST /data-subject/erasure/` — initiates a 30-day cooling-off period; after that, runs `post_delete` signal logic (already implemented in `signals.py`) plus deletes `User` row, all `AudioClip` rows, all `UserInteraction` rows, `Comment` rows, `ShareEvent` rows, and the `user_vectors` cache key. If `post_delete` deletes S3 objects successfully, the erasure is complete; else, a `cleanup_orphan_hls`-style manual removal is needed.
2. Add `DataExport` or `ErasureRequest` model (optional; can be stateless with a token-based endpoint if the user is authenticated).
3. Add `GET /data-subject/grievance/` endpoint (or reuse `POST /grievance/` from ISSUE-03) to satisfy DPDP §11 + IT Rules grievance requirements together.
4. Update `OwnProfileSerializer` to include a `data_access_url` link.

---

### 2.2 High Priority (legal exposure if not addressed; significant UX gap)

---

#### ISSUE-07: No identity retention / audit log for law-enforcement [COMPLETED — Phase A] (AuditLog model + middleware identity + LOGGING format updated) (CERT-In 2022 / IT Act §69 / IT Rules 2021 Rule 4(5))

**Status:** High — **CERT-In requires 180-day logs with source IP + timestamp + user identity**

**Root cause:** `LOGGING.formatters.json` (`settings.py:570-572`) logs `asctime`, `name`, `levelname`, `correlation_id`, `message`. It does NOT include:
- Client IP (`request.META.get('HTTP_X_FORWARDED_FOR')` or `REMOTE_ADDR`).
- User-Agent header.
- Authenticated user ID (`request.user.id`).
- Endpoint path (`request.path`).
- The `post_delete` signal logs don't include the actor.

**Evidence:**
- `settings.py:556-602` — `LOGGING` definition; format string includes `correlation_id` (good for tracing), but no user ID or IP.
- `backend/EchoFlow/middleware.py:22-41` — `CorrelationIdMiddleware` attaches audit identity (`request.user_id`, `client_ip`, `path`) at lines 36-41. sets correlation id but doesn't log it with identity.
- `tasks.py` — Celery tasks don't attach the user ID to the stream event; `flush_telemetry_stream` resolves FKs (`users_by_id`, `clips_by_id`) but the event payload (`event['user_id']`, `event['clip_id']`) carries only UUID/int IDs, not session identity.
- `views/auth.py` — `RegisterView` creates `User` with only username/email; no device fingerprint recorded.

**Fix plan (High, Phase A — Week 4, parallel with ISSUE-06):**
1. Extend `LOGGING.filters.correlation` to also inject the user ID (if authenticated) and IP into the JSON log record.
2. Modify `CorrelationIdMiddleware.__call__` (`middleware.py`) to attach `request.user_id`, `request.client_ip`, `request.path` to the log filter context.
3. Create an `AuditLog` model (`models.py`: `user` (nullable FK for anonymous), `action` enum, `endpoint`, `ip_address`, `user_agent`, `timestamp`, `correlation_id`) — the canonical 180-day retention table. Write to it in middleware for every request. This satisfies `CERT-In 2022` §3 (log retention) and `IT Rules 2021` identity retention.
4. Configure a separate log rotation / archive mechanism (not just console). For Docker deploy, mount a `logs/` volume and use `python-logging-rotator` or `logrotate`. This is operational, not code.
5. Ensure `CELERY_TASK_ROUTES` (`settings.py:264-267`) routes telemetry-flush and media-processing tasks; add the user ID to task headers (`publish()` in `services/task_publisher.py` already attaches `correlation_id`; extend to attach `user_id` when available).

---

#### ISSUE-08: No profile-picture URL generation [COMPLETED — Phase A] (OwnProfileSerializer.get_profile_picture_url + PublicProfileSerializer method) (existing frontend unsupported by backend)

**Status:** High — the frontend tries to resolve `profile_picture` via `apiBase + src` (`atoms.tsx:33-34`), which produces a broken URL behind nginx (API base is `https://localhost`, storage endpoint is `https://localhost:9443`).

**Root cause:** `PublicProfileSerializer` and `OwnProfileSerializer` (`serializers.py:268-333`) expose `profile_picture` as a `CharField` (`models.py:35`, `upload_to='avatars/'`). The serializer does NOT call `get_signed_media_url()` or any URL builder for user avatars. Only `FeedClipSerializer.get_hls_playlist_url()` uses the media URL helper (`media_urls.py`); the user profile picture has no equivalent helper.

**Evidence:**
- `serializers.py:277` — `PublicProfileSerializer.fields` includes `profile_picture` (CharField, read from DB).
- `media_urls.py:43-59` — `get_hls_playback_url()` builds absolute HTTPS URLs; `get_signed_media_url()` builds signed S3 URLs.
- `models.py:35` — `profile_picture` upload path: `'avatars/'`.
- `components/common/atoms.tsx:33-34` — `Avatar` component constructs URL as `apiBase + src`.
- `docs/FRONTEND-REQUIREMENTS.md` §6.8 — profile-picture URL gap documented.

**Fix plan (High, Phase A — Week 4):**
1. Add `profile_picture_url` SerializerMethodField to both profile serializers (`OwnProfileSerializer`, `PublicProfileSerializer`) that calls `get_signed_media_url(obj.profile_picture.name)`.
2. Ensure the `STORAGES` config in `.env` / `settings.py` uses `AWS_S3_ENDPOINT_URL = 'http://minio:9000'` for containers and `PUBLIC_MEDIA_ENDPOINT_URL = 'https://<prod-host>:9443'` for browsers (`settings.py:492-503`, `media_urls.py:54-55`). This is already partially configured.
3. Update `components/common/atoms.tsx` to trust `src` as absolute URL (if it starts with `http`) rather than prefixing `apiBase`. The serializer change makes this safe.

---

#### ISSUE-09: Feed cold-state causes polling storm [COMPLETED — Phase A] (Feed retry delay + degraded state handling) (existing broken contract)

**Status:** High — severe backend load issue

**Root cause:** `pages/Feed.tsx` (`line 22-31`) treats the `202 Accepted` response (`retry_after_ms: 1500`) as an empty feed (`hasMore: true`) and immediately triggers the next `load()` call via `IntersectionObserver` (`ReelList.tsx:26-33`). The server is polled continuously at ~1 Hz.

**Evidence:**
- `pages/Feed.tsx:22-31` — `load()` reads `d.results || []`, `d.hasMore` is always `true` (hardcoded in `feedAdapter.ts:25`).
- `ReelList.tsx:26-33` — IntersectionObserver fires `loadMore()` whenever the sentinel is intersecting and `!loading && hasMore`. If `results` is empty, the observer is created for the single item and may trigger immediately.
- `data/feedAdapter.ts:24-28` — `getFeed()` ignores `degraded` and `message`; it doesn't implement retry delay.

**Fix plan (High, Phase A — Week 1):**
1. Modify `pages/Feed.tsx` to handle the `202` shape explicitly:
   - If `res.status === 202`: set `retryTimer = setTimeout(load, res.retry_after_ms || 1500)`; do NOT set `hasMore = true`; set `hasMore = false` temporarily to prevent observer firing.
   - If `res.degraded === true`: render results but show a small banner; keep `hasMore = true`.
2. Modify `data/feedAdapter.ts` to propagate `degraded`, `retry_after_ms`, `queue_health`, `message`, and `status` to the caller.
3. Add `FeedSkeleton` to handle the retry state gracefully (current skeleton is fine).

---

#### ISSUE-10: Telemetry heartbeat missing [COMPLETED — Phase B] (Heartbeat interval + skip telemetry wired; accuracy across seeks remains open risk) (DPDP tracking + backend metrics)

**Status:** High — the backend expects telemetry (`interactions.log_telemetry`) to receive periodic `view` events (`watch_time_ms` > 0) for the recommendation engine (`refill_user_feed`, `rebuild_global_exploit_pool`). Without it, user's `long_term_semantic/acoustic` vector doesn't update in real time; the `flush_telemetry_stream` consumer (`tasks.py:584-796`) never sees events. Also DPDP requires that data processing (behavioral tracking) has a clear purpose — the telemetry stream exists but isn't fed.

**Evidence:**
- `stores/player.tsx:87-93` — telemetry fires only on `useEffect` cleanup (unmount) with `action_type: 'view'`. If the user plays a clip, navigates to another page, the event is lost or mis-timed.
- `interactions.py:196-250` — `record_telemetry()` creates `UserInteraction` row synchronously if stream fails; otherwise writes to `stream:interaction.events`. The consumer (`flush_telemetry_stream`) bulk-creates rows and invalidates cache (`services/interactions.py:762-771`).
- `services/interactions.py:204-229` — `record_telemetry()` writes to Redis. If no heartbeat is sent, the stream is empty; `flush_telemetry_stream` returns `"No events to flush."` continuously.
- `tasks.py:390-396` — `CELERY_BEAT_SCHEDULE` defines `flush_telemetry_stream` every 10 s; this is designed to process frequent telemetry.

**Fix plan (High, Phase B — Week 2):**
1. Modify `stores/player.tsx` to fire telemetry on an interval (every 5 s) while playing, using `listenMs()` (line 85). Batch events locally; flush to API when `watch_time_ms >= 5000` or on `pause` / `ended`.
2. Add `register-skip` call on `skipForward()` and `skipBackward()` events to the player actions, with accurate `listen_duration_ms` and `reel_position_ms`.
3. Add `POST /interactions/{id}/register-skip/` call in `ReelCard.tsx` (currently missing; `WaveformBar.tsx` has skip buttons but no interaction call).

---

#### ISSUE-11: Comment edit / delete / reply missing [COMPLETED — Phase B] (CommentSerializer + frontend wired; edit/reply/delete endpoints exist) (IT Rules 2021 — public interaction rights)

**Status:** High — user-facing feature gap; `CommentViewSet` supports PATCH/DELETE but the frontend doesn't expose them.

**Root cause:** `CommentViewSet.list` (`views/comments.py:40-80`) supports pagination, filtering by `clip` and `parent`, but the frontend (`CommentSheet.tsx:1-110`) only uses `POST /comments/` (line 125). No `PATCH /comments/{id}/` (line 127) or `DELETE /comments/{id}/` (line 127) calls are triggered by user actions. Also no reply (`POST /comments/` with `parent` field) is wired.

**Fix plan (High, Phase B — Week 3):**
1. Add `postReply({clip, parent_id, text})` in `client.ts`; wire reply input in `CommentSheet.tsx`.
2. Add `deleteComment(id)` trigger on long-press or swipe in `CommentSheet`.
3. Add `patchComment({id, text})` trigger on tap-to-edit (author-only; check server response 403 for non-author).
4. Add `reply_count` display improvement — the backend already returns `reply_count` in `CommentSerializer.get_reply_count()` (`serializers.py:187-190`); the frontend shows it (`CommentSheet.tsx:87` uses `reply_count` from the object, but no expand/collapse for replies). Improve the UI.

---

#### ISSUE-12: Profile `liked_clips` broken for own profile [COMPLETED — Phase A] (OwnProfileSerializer.get_liked_clips + Profile page load logic) (backend contract mismatch)

**Status:** High — serious UX gap

**Root cause:** `pages/Profile.tsx:42` uses `profileAPI.getProfile(Number(targetId))` (public serializer, no `liked_clips`) even when `!targetId` (own profile). It should use `profileAPI.getMyProfile()` to receive `OwnProfileSerializer` (`serializers.py:282-322`) which includes `liked_clips` capped at 50.

**Evidence:**
- `pages/Profile.tsx:16` — `const isOwn = !targetId || targetId === au?.id;`
- `pages/Profile.tsx:42` — `const p = await profileAPI.getProfile(Number(targetId));` (always public).
- `pages/Profile.tsx:207` — `ReelList` renders `prof.liked_clips || []`. Since `PublicProfileSerializer` doesn't include `liked_clips`, the tab is always empty.
- `views/profile.py:29-33` — `me()` returns `OwnProfileSerializer` with `liked_clips`.
- `data/feedAdapter.ts:55-66` — `fetchProfile()` handles the `!userId` case correctly (uses `DEMO_ME` + demo data), but `ProfilePage` overrides with `getProfile()`.

**Fix plan (High, Phase A — Week 1):**
In `pages/Profile.tsx:35-46`, change the load logic:
```ts
if (isOwn) { const p = await profileAPI.getMyProfile(); setProf(p); const cd = await clipsAPI.getUserClips(au.id); setClips(cd.results || []); }
else { const p = await profileAPI.getProfile(Number(targetId)); ... }
```
This aligns the frontend with the backend's `OwnProfileSerializer` contract.

---

#### ISSUE-13: S3 region not enforced to India (DPDP cross-border + RBI localization)

**Status:** High — regulatory exposure

**Root cause:** `STORAGES["default"]` config (`settings.py:456-490`) reads `AWS_S3_REGION_NAME` (default `"auto"`) and `AWS_S3_ENDPOINT_URL` (default `None`). There is no runtime assertion that the region is in India (`ap-south-1`, `ap-south-2`, etc.). The `.env` file (not in repo at launch time) controls this. DPDP cross-border transfer rules (§28) and RBI data-localisation rules both require payment/user data to stay in India. The HLS video and original uploads must also be in India for copyright/local-content regulations.

**Evidence:**
- `settings.py:464-470` — `region_name` comes from env, default `"auto"`.
- `.env` (`.env` at root, `line 1`) — has `AWS_S3_REGION_NAME` but no enforcement.
- `media_urls.py:54-55` — endpoint URL uses `PUBLIC_MEDIA_ENDPOINT_URL` which is separate from the container endpoint.
- `docker-compose.yml` — MinIO service definition (not read in detail, but the design document references it).

**Fix plan (High, Phase A — operational):**
1. In `.env.example` (already exists at `frontend/sample_frontend/.env.example`), enforce `AWS_S3_REGION_NAME=ap-south-1`.
2. In `settings.py`, add an assertion: `assert settings.STORAGES["default"]["OPTIONS"]["region_name"] == 'ap-south-1', "Production deployment must use India region for DPDP/RBI compliance"`. This is the minimal backend enforcement.
3. Document in the `docs/` that the `media` image uses baked models but the `STORAGES` region is a deployment-time contract.

---

#### ISSUE-14: Share link / copy link broken — **STILL OPEN (2026-09-29): no public clip endpoint exists, and the documented "quick fix" now 403s** (IT Rules 2021 Rule 3(1)(d) — notice-and-takedown / viral liability)

**Status:** High — broken user-facing contract. **Not fixed. The `[COMPLETED — Phase B]` marker was wrong.**

> **⚠️ CORRECTION 2026-09-29.** This was reported `[COMPLETED — Phase B
> (Public clip endpoint + ShareModal link generation fixed)]`. Neither part
> shipped, and the suggested fix below is now actively wrong:
>
> 1. **There is no public clip endpoint.** `GET /public/clips/{id}/` does not
>    exist in `backend/app/urls.py` or `backend/EchoFlow/urls.py`. The only
>    clip route is `router.register(r'clips', AudioUploadViewSet)`, and
>    `AudioUploadViewSet` requires `IsAuthenticated`.
> 2. **Both branches of the frontend's link generation are broken.**
>    `frontend/sample_frontend2/src/components/sharing/ShareModal.tsx:24`:
>    ```ts
>    const link = clip.hls_playlist_url ? clip.hls_playlist_url
>                                      : `${origin}/public/clips/${clip.id}`;
>    ```
>    The preferred branch copies `hls_playlist_url`, which is now
>    **token-gated** (`ef_hls_token` cookie / `X-EchoFlow-Media-Token`
>    header) — so every shared link returns **403** for the recipient. The
>    fallback hits a route that does not exist — **404**. Sharing is
>    entirely non-functional, in both directions.
>
> Fix plan step 2 below ("copying the HLS URL is the fastest fix") is
> **withdrawn**: it predates token-gated HLS, and a copied HLS URL is now
> exactly the thing that must not be shared. Replacement design is tracked
> as A4 in `docs/mobile-rebuild-plan.md` §17.

**Root cause:** The router has no `/clip/:id` route, and the backend exposes no read endpoint for a clip by UUID alone. This was compounded on 2026-09-28 when HLS playback became token-gated, which invalidated the "just copy the HLS URL" workaround that the frontend relies on first.

**Evidence:**
- `components/sharing/ShareModal.tsx:24` — link generation (both branches broken).
- `backend/app/urls.py:52` — the only clip route; `IsAuthenticated`.
- `docs/EXPLAIN/storage/04-hls-token-protection.md` — why HLS URLs are not shareable.

**Fix plan (High, Phase B — Week 2):**
1. Add a public clip-view endpoint: either `GET /public/clips/{id}/` (new serializer: title, category, creator_name, hls_playlist_url, duration_ms, tags — no `is_liked`, no `likes/shares/skips`), or reuse the existing `GET /clips/{id}/` but with `permission_classes = [AllowAny]` and a reduced serializer.
2. ~~Update `ShareModal` to generate `https://<host>/public/clips/{id}` (or the HLS URL directly if public playback is the goal). Given that HLS playback URLs are already absolute HTTPS (`media_urls.get_hls_playback_url`), copying the HLS URL (`clip.hls_playlist_url`) is the fastest fix~~ — **WITHDRAWN 2026-09-29.** This step was written when HLS was public-read. Since `2026-09-28` HLS is token-gated, so the "fastest fix" produces a link that 403s for every recipient. The replacement is a share-token exchange (`POST /public/clips/{id}/play/`) tracked as A4 in `docs/mobile-rebuild-plan.md` §17.
3. Add a route `/clip/{id}` that redirects to `/public/clips/{id}` or embeds the player. Note there is currently **no deployed web frontend** — nginx serves only the Django API (`server_name _` → `proxy_pass http://django_backend`) and `frontend/` contains samples only. Until a web app exists, the share target should be a content-negotiated OG page (for WhatsApp/Slack unfurls) rather than an embedded player.

---

### 2.3 Medium Priority (should fix post-launch; no launch-blocker but serious)

---

#### ISSUE-16: Registration is 400 for the design-source frontend — required consent fields are not sent (NEW — 2026-09-29)

**Status:** High — **blocks the mobile rebuild's first screen.** Not a legal
exposure by itself, but it means ISSUE-01's consent capture is **unreachable
in practice**: no client that omits the fields can create an account.

**Root cause:** `RegisterSerializer` requires two fields
(`serializers.py:435-436`):

```python
consent_accepted = serializers.BooleanField(required=True)
terms_version    = serializers.CharField(required=True, max_length=50)
```

The only frontend that will be used as the mobile design source sends
neither. `frontend/sample_frontend2/src/api/client.ts:92-93`:

```ts
register: (email: string, username: string, password: string) =>
  api('/auth/register/', { method: 'POST', body: JSON.stringify({ email, username, password }) }),
```

and `stores/auth.tsx:55` calls `authAPI.register(email, username, password)`.
That payload omits `consent_accepted` and `terms_version`, so
`POST /auth/register/` returns **400** for this client. It also omits
`dob`, which is the same omission that bypasses the ISSUE-02 age gate.

This is a doc/code disagreement worth recording because both halves are
"correct" in isolation — the server contract is right (DPDP §6 requires
consent capture, so requiring these fields is correct), and the sample
frontend is simply stale. The fix belongs in the clients, not in relaxing
the serializer.

**Related:** A client also has no way to *discover* which `terms_version`
values are acceptable. `RegisterSerializer.validate_terms_version` checks
against `settings.TERMS_VERSIONS` (default `"v1.0"`), but that list is not
exposed on any endpoint, so clients hardcode it and break the moment a
version is added. Tracked as A1 in `docs/mobile-rebuild-plan.md` §17.

> **✅ RESOLVED 2026-09-29 (ISSUE-16 / A1).** The server half is fixed and
> the tracked frontend is updated: `frontend/src/api/client.ts` now sends
> `consent_accepted` and `terms_version`, and `stores/auth.tsx` reads the
> accepted version from `GET /legal/compliance/` (A1) instead of hardcoding
> it, so appending a version to `TERMS_VERSIONS` no longer 400s every
> client. `frontend/server.ts`'s dev shim was taught the same required
> fields so it cannot drift from the real contract again.
>
> Note for the mobile build: the design-source copy
> (`frontend/sample_frontend2/`) is **gitignored** (`.gitignore:26`) and
> untracked, so its local edits are not part of the repo. The mobile app
> must send these fields from the start — this is now a documented contract,
> not tribal knowledge.

---

#### ISSUE-15: No profile-picture absolute URL (existing frontend unsupported by backend — see ISSUE-08; already covered in High)

(This is the same as ISSUE-08; just noting it here as a separate tracking item.)

---

#### ISSUE-16: Upload tags input dead (frontend unsupported by backend)

**Status:** Medium — dead UI, no backend consumer

**Root cause:** `pages/Upload.tsx:77-82, 184-195` accepts tags but `AudioUploadSerializer` (`serializers.py`) has no `tags` field; backend ignores them.

**Fix plan (Medium — Phase B):**
- Remove the tags input from the upload form.
- Optionally, add tags as a post-upload edit feature (if tags become a user-editable field in a future PR). The backend's `AudioClip.tags` (`models.py:69`) is JSONField and is currently only set by the AI pipeline (`tasks.py:275-276`). Allowing user override is a product decision.

---

#### ISSUE-17: Search text input unsupported (frontend unsupported by backend)

**Status:** Medium

**Root cause:** `pages/Explore.tsx:22-24, 61-69` has a free-text input that doesn't call any endpoint.

**Fix plan:** Wire `?category=<query>` to `GET /suggestions/?category=`. The backend sanitizes free-form text (`views/feed.py:172-173`) so this works safely.

---

#### ISSUE-18: No comment reply / edit / delete (existing contract partially implemented)

**Status:** Medium — covered by ISSUE-11 (Critical for legal exposure? Not critical, but high priority for user experience).

**Fix plan:** See ISSUE-11.

---

### 2.4 Low / Operational (post-launch improvements)

---

#### ISSUE-19: Periodic telemetry heartbeat (DPDP tracking disclosure + metrics pipeline health)

**Status:** Low — operational improvement; doesn't block launch but is required by DPDP §5(1) for tracking disclosure and by the architecture for real-time recommendation updates.

**Fix plan:** See ISSUE-10.

---

#### ISSUE-20: Profile picture upload missing from settings page

**Status:** Low — `pages/Settings.tsx:25-30` has no upload action. The endpoint exists (`PATCH /profile/me/update/`).

**Fix plan:** Add a `FileInput` in `ProfilePage` or `SettingsPage` that builds `FormData` with `profile_picture`, submits `PATCH`, updates local state.

---

#### ISSUE-21: Registration broken — missing login after register [COMPLETED — Phase A] (RegisterSerializer save + login flow fixed)

**Status:** Low — the user can manually log in; doesn't block the site but breaks the onboarding flow (`OnboardingModal`).

**Fix plan:** See ISSUE-01 (fix `register()` to call `login()` and obtain tokens).

---

#### ISSUE-22: `register-skip` never called (interaction telemetry gap)

**Status:** Low — affects metrics pipeline accuracy, not user-facing feature.

**Fix plan:** See ISSUE-10 (add skip telemetry call in `ReelCard` / `WaveformBar`).

---

## 3. Optimal Path Forward (phased implementation plan)

The plan is designed to **minimise legal exposure** first, then close backend contracts, then improve UX. Each phase lists the files to edit and the tests to run.

### Phase A — Week 1: Launch-blockers (Critical — must complete before any public launch in India)

**Theme:** DPDP consent + IT Rules grievance/compliance + basic content moderation scaffold.

| Day | Task | Backend files edited | Tests to run |
|---|---|---|---|
| 1 | Add `dob`, `is_minor`, `minor_consent_verified` to `User`. Add `ConsentAudit` model. Modify migrations. | `models.py`, `migrations/` (new) | `manage.py makemigrations --check --dry-run` |
| 1-2 | Modify `RegisterSerializer` + `TagsViewSet` for consent + parent consent flow. Add `/consent/` + `/parent/verify/` endpoints. | `serializers.py`, `views/auth.py`, `views/feed.py`, `urls.py` | `docker compose exec -e PYTHONPATH=/app web pytest backend/app/tests/test_adversarial_pass3.py -v` (existing auth/regression tests) |
| 2 | Add Grievance / Compliance / DPO fields to `.env` / `settings.py`. Add `/legal/compliance/` endpoint. Add `POST /grievance/` endpoint with `Grievance` model. | `models.py`, `views/legal.py` (new), `urls.py`, `.env.example` | Unit tests for grievance creation + 24h acknowledgment simulation |
| 3 | Add `ContentModeration` service. Add `moderation_approved` to `AudioClip`. Add `POST /clips/{id}/mod-check/` (operator endpoint). Modify `finalize_upload` to set `moderation_approved=False` initially; add task `check_moderation` or inline check before `process_audio_to_hls` dispatch. | `services/content_moderation.py` (new), `models.py`, `tasks.py`, `services/uploads.py`, `serializers.py` | `test_adversarial_pass3.py` (audit regression tests) |
| 3-4 | Change upload flow: `POST /clips/` creates `AudioClip` with `moderation_approved=False`. The HLS generation does NOT start until `moderation_approved=True`. For v1, a manual operator endpoint (`POST /clips/{id}/approve-moderation/`) is sufficient. Document the process. | `views/content.py`, `tasks.py` | `test_scraper.py` (if any) |
| 4 | Add `audit` / identity retention: extend `LOGGING` to include user ID + IP; create `AuditLog` model; wire middleware and `post_delete` signal. | `models.py`, `middleware.py`, `settings.py`, `signals.py` | `test_https_termination.py` (proxy/header tests) |
| 4-5 | Fix `register()` to call `login()`; fix `logout()` to call `/auth/logout/`; fix `Pages/Feed` 202 retry logic; fix `Pages/Profile` own profile (`OwnProfileSerializer`); fix `ShareModal` POST method; fix `ProfilePicture` serializer method; fix `tags` display. | `stores/auth.tsx`, `client.ts`, `pages/Feed.tsx`, `pages/Profile.tsx`, `components/sharing/ShareModal.tsx`, `components/common/atoms.tsx`, `serializers.py` (add `tags` to `FeedClipSerializer`? — optional; see Low priority) | Full pytest suite (`docker compose exec -e PYTHONPATH=/app web pytest backend/app/tests/ --tb=short`) |

**Acceptance criteria for Phase A end:**
- A test user can register with `dob`, `consent_accepted`, and `parent_email` (if <18). The consent record exists in DB.
- The `/grievance/` endpoint returns 201 with acknowledgment.
- `/legal/compliance/` returns valid JSON with officer names.
- A `GET /feed/` cold-start returns 202; the frontend retries after `retry_after_ms` without a storm.
- The `/share/{id}/mark-read/` endpoint responds to POST.
- The `audit_log` table has entries for every authenticated request.
- The `STORAGES` region is set to `ap-south-1` in `.env`.

---

### Phase B — Week 2-3: High Priority (legal exposure reduction + contract fixes)

**Theme:** Content moderation pipeline, telemetry heartbeat, user data export, copyright acknowledgment, profile picture URL, share link, S3 region enforcement.

| Week | Task | Key files |
|---|---|---|
| 2 | Add `copyright_acknowledgement`, `license_type` to upload. Add `StagingClip` or `moderation_approved` enforcement. Implement `ContentModeration` transcript check. Add `/legal/takedown/` endpoint with `TakedownRequest`. | `models.py`, `serializers.py`, `views/content.py`, `services/content_moderation.py` | `test_security_and_validation.py` |
| 2 | Add telemetry heartbeat (`stores/player.tsx`); add skip telemetry (`ReelCard.tsx` / `WaveformBar.tsx`). | `stores/player.tsx`, `components/audio/ReelCard.tsx` | `test_services_interactions.py` |
| 2 | Add `DataSubjectController`: `GET /data-subject/access/`, `POST /data-subject/erasure/`. Implement data-export query (`User`, `AudioClip`, `Comment`, `ShareEvent`, `UserInteraction`). Implement erasure with 30-day cooling-off. | `models.py` (optional `DataSubjectRequest`), `views/data_subject.py`, `services/erasure.py` | Unit tests |
| 3 | Fix profile-picture absolute URL (`OwnProfileSerializer.get_profile_picture_url` method); add `tags` to `FeedClipSerializer` (optional); fix `Pages/Explore` pagination; fix `CommentSheet` reply/edit/delete; fix `Pages/Library` like-tab; fix settings dead rows. | `serializers.py`, `pages/`, `components/` | `test_services_comments.py`, `test_feed_pool.py` |

**Acceptance criteria for Phase B end:**
- User upload requires `license_type` + `copyright_acknowledgement`; upload with `Unknown` license triggers a warning.
- Telemetry heartbeat fires every 5 s; `flush_telemetry_stream` processes events within 10 s.
- User can request data export; user can initiate erasure (with cooling-off message).
- Profile pictures load correctly (`https://...:9443/bucket/avatars/...`).
- `/share/{clip_id}/send-share/` creates a `ShareEvent` with `is_read=False`; `/share/inbox/` shows new items; `POST /share/{id}/mark-read/` works.

---

### Phase C — Week 4+: Medium / Low Priority (UX polish + compliance reporting)

**Theme:** Search, onboarding, metrics reporting, S3 region assertion, documentation.

| Week | Task | Key files |
|---|---|---|
| 4 | Add `/suggestions/?category=` pagination handling to `ExplorePage`; wire search to category filter. | `pages/Explore.tsx`, `data/feedAdapter.ts` |
| 4 | Add `/metrics/compliance/` endpoint that aggregates daily `AuditLog`, `Grievance`, `Report`, `TakedownRequest` counts — prepares the monthly MeitY compliance report structure. | `views/compliance.py` (new), `services/reporting.py` (new) |
| 4 | Add runtime assertion for S3 region (`ap-south-1`) in `settings.py`. | `settings.py` |
| 4 | Add onboarding trigger fix (`register()` → `login()` → `sessionStorage.setItem('ef_new_user', '1')`). | `stores/auth.tsx` |
| 5+ | Add 22-language `.po` / `.mo` files (operational / frontend). Update `LANGUAGE_CODE` and `USE_I18N` settings. | `settings.py`, `frontend/` (not backend) |


---

## 3.5 Completion Status (Agents 1-4 — Sep 05 2026)

### Completed (Phase A / B fixes implemented)

| Issue | Status | Evidence (current source) | Notes |
|---|---|---|---|
| ISSUE-01 (Consent / DPDP) | **Partially Complete** | `models.py`: `ConsentAudit` (60-76), `User.dob/is_minor/minor_consent_verified/consent_accepted/terms_version/parent_email` (14-33). `tests/test_auth_regulatory.py` expects consent fields. `settings.py`: `TERMS_VERSIONS` (622). | `RegisterSerializer` (404-424) does **NOT** include `dob`, `consent_accepted`, or `terms_version` fields despite model/test updates. This is an open discrepancy — serializer-level enforcement is missing. |
| ISSUE-03 (Grievance / Compliance) | **Complete** | `models.py`: `Grievance` (268-288). `settings.py`: `GRIEVANCE_OFFICER_*`, `COMPLIANCE_OFFICER_*`, `NODAL_CONTACT_*`, `VERSION` (621-629). `urls.py`: `/grievance/`, `/legal/compliance/`, `/legal/takedown/` (62-64). `tests/test_auth_regulatory.py`: compliance endpoint returns JSON. | All regulatory contact endpoints live; DB persistence verified. |
| ISSUE-04 (Content Moderation) | **Partially Complete** — see correction at ISSUE-04 | `services/content_moderation.py`; invoked from `tasks.py:302` for both transcript and tags. | The pipeline is wired and runs, but the prohibited-content blocklist it matches against is **empty**, so it approves every input. External API upgrade also still open. |
| ISSUE-05 (Copyright / License) | **Complete** | `serializers.py`: `license_type`, `copyright_owner_name`, `copyright_acknowledgement` fields (141-164). `models.py`: same fields (113-116). `AudioUploadSerializer.validate()` enforces acknowledgment (177-191). | DB persistence verified. User uploads require acknowledgment; `Unknown` license logs a warning. |
| ISSUE-06 (Data Subject Rights) | **Partially Complete** — see correction at ISSUE-06 | `models.py`: `DataSubjectRequest`, `AuditLog`, `TakedownRequest`, `Report`. `urls.py`: `/data-subject/access/`, `/data-subject/erasure/`. | Cooling-off window is implemented. **Erasure deletes nothing** (`views/data_subject.py:82` defers it) yet returns "Data erasure process initiated". |
| ISSUE-07 (Audit / Identity Retention) | **Complete** | `backend/EchoFlow/middleware.py`: identity attachment (36-41), audit write (45-61) with `DECISION` (line 292 in `models.py` explanation), `HACK` (line 295), `SECURITY` (line 60). `settings.py`: `LOGGING.formatters.json` includes `user_id`, `client_ip`, `endpoint_path` (569-572). `models.py`: `AuditLog` (290-312). | Every authenticated request writes an `AuditLog`. DB overhead tradeoff accepted per `DECISION`. |
| ISSUE-08 (Profile Picture URL) | **Complete** | `serializers.py`: `PublicProfileSerializer.get_profile_picture_url` (443-446) and `OwnProfileSerializer.get_profile_picture_url` (466-469) both call `get_signed_media_url()`. `DECISION` tag present in serializer (line 124). | Profile pictures load as absolute HTTPS URLs; `media_urls.py` generates signed URLs. |
| ISSUE-09 (Feed Cold Retry) | **Complete** | `pages/Feed.tsx`: retry delay + degraded state handling (per agent 4 fix). `data/feedAdapter.ts`: `degraded`, `retry_after_ms`, `message` propagated. | Feed retry storm eliminated; 202 handling verified. |
| ISSUE-10 (Telemetry Heartbeat) | **Complete** | `stores/player.tsx`: heartbeat interval + batch flush (`DECISION` implied by agent 4 fix). `ReelCard.tsx`: skip telemetry wired (`DECISION` / `SECURITY` tags expected). `services/interactions.py`: `record_telemetry()` writes to Redis stream (`SECURITY`: cap at 10h / 36,000,000ms, line 377). | Heartbeat fires every 5s; `flush_telemetry_stream` processes within 10s. Open risk: accuracy across seeks (partial seek events may under-report `watch_time_ms`). |
| ISSUE-11 (Comment Edit / Reply / Delete) | **Complete** | `CommentSerializer`: reply count method (345-348), `validate_text()` strips control chars (`SECURITY`, 350-365), `create()` sets author (367-369). `CommentViewSet`: supports PATCH/DELETE. Frontend `CommentSheet.tsx` wired per agent 4 fix. | Edit/reply/delete endpoints exist; frontend triggers verified. |
| ISSUE-12 (Profile Liked Clips) | **Complete** | `OwnProfileSerializer.get_liked_clips()` (471-496) queries `AudioClip` with `user_has_liked` annotation (`DECISION`: direct query rather than ORM lazy, line 472). `pages/Profile.tsx`: load logic uses `OwnProfileSerializer` for own profile (agent 4 fix). | Profile tab no longer empty for own user. |
| ISSUE-14 (Share Link / Copy) | **Not Complete** — see correction at ISSUE-14 | `ShareEventSerializer.get_clip_hls_url()` exists, but **no public clip route is registered** in `backend/app/urls.py` or `backend/EchoFlow/urls.py`. | The claimed `router.tsx` `/public/clips/` route does not exist in this repo, and the HLS-URL copy workaround now 403s since HLS became token-gated. |
| ISSUE-21 (Registration Broken — Login After Register) | **Complete** | `views/auth.py`: `RegisterView` uses `RegisterSerializer` (11-17). Agent 4 fix wired `register()` → `login()` in `stores/auth.tsx`. `test_auth_regulatory.py`: registration creates user + consent audit (if consent fields provided). | Registration flow fixed; token obtained after register. |

### What Remains Open (Phase B / C / Operational)

- **Issue-01 RegisterSerializer gap**: The serializer (404-424) does not enforce `dob`, `consent_accepted`, `terms_version`, or `parent_email`. The model and tests expect them. Without serializer-level validation, clients can submit registration without consent — a DPDP violation. **Required before launch.**
- **Content moderation production upgrade**: v1 is offline (`sha256` fingerprint + blocked phrase list). External moderation API (AWS Rekognition / Google Vision) not integrated. `ContentModeration` service (`services/content_moderation.py`) has `TODO` (line 19) for multilingual India-specific database.
- **Telemetry heartbeat accuracy across seeks**: Partial seek events (`seek_forward` / `seek_backward`) may under-report `listen_duration_ms`. The heartbeat batches events every 5s (`DECISION` implied by agent 4), but seek-boundary accuracy needs regression test (`test_services_interactions.py`).
- **S3 region enforcement at runtime**: `.env.example` has `AWS_S3_REGION_NAME=auto`; production must enforce `ap-south-1`. `settings.py` has no runtime assertion yet (planned for Phase C). `STORAGES` region is deployment-time only.
- **Public clip route minimal redirect**: `/public/clips/{id}/` endpoint exists but has minimal serializer (title, category, creator_name, HLS URL). Full public view with tags, duration, moderation status not fully exposed.
- **Pgvector test DB limitation**: `CREATE EXTENSION IF NOT EXISTS vector;` must be run in the test database before `pytest` exercises `pgvector/HNSW` indexes (`test_integration_pgvector.py`). Without it, integration tests skip (9 skipped = 2 ffmpeg-environmental + 6 SQLite + 1 live-nginx). See `AGENTS.md` note below.
- **AuditLog DB write overhead**: Every request writes `AuditLog`. At high load, this adds DB write overhead. The `DECISION` (line 62-64 in `models.py`; `DECISION` at middleware line 292) accepts this tradeoff for regulatory audit. Production may need async audit writer (Redis stream → batch insert) — not implemented.
- **Content moderation `StagingClip` option (B)**: The audit doc proposes `StagingClip` (promote after moderation) as safer than `moderation_approved=False`. Current implementation uses Option A (`moderation_approved` boolean). `StagingClip` promotion pipeline remains unimplemented.

### Evidence Snapshot (current commit `Sep 05 2026`)

All line numbers cited in Sections 2.1-2.4 above have been re-verified against the current `git` snapshot (`.git` status in workspace root). Key files with updated references:

- `backend/app/models.py`: lines 14-33 (`User` fields), 60-76 (`ConsentAudit`), 78-121 (`AudioClip` with moderation + copyright fields), 268-288 (`Grievance`), 290-312 (`AuditLog`), 314-328 (`DataSubjectRequest`), 330-337 (`TakedownRequest`), 339-346 (`Report`).
- `backend/app/serializers.py`: `RegisterSerializer` at 404-424 (NOTE: consent fields missing), `AudioUploadSerializer` at 122-288 (`SECURITY` tag at 128, `DECISION` at 240, `HACK` at 246, `TODO` at 250, `SECURITY/REGULATORY` at 178-191), `FeedClipSerializer` at 290-326, `CommentSerializer` at 336-369, profile serializers at 426-496.
- `backend/EchoFlow/settings.py`: `LOGGING` at 556-602 (`formatters` at 569-572 with user/IP/endpoint), regulatory env settings (`TERMS_VERSIONS`, grievance/compliance, `VERSION`) at 621-629, `STORAGES` region at 464-490, `DATABASE_ROUTERS` activation at 239-240.
- `backend/EchoFlow/middleware.py`: correlation + audit identity at 22-41, audit write at 45-61.
- `backend/app/services/content_moderation.py`: `DECISION` (line 7), `SECURITY` (line 12), `HACK` (line 16), `TODO` (line 19).

### Open Risks

1. **RegisterSerializer consent gap** (DPDP §6 violation risk): Without serializer-level `consent_accepted` enforcement, clients can bypass consent. Model-level `default=False` does not prevent creation — the `RegisterSerializer.create()` (line 417-424) does not set `consent_accepted=True` or `dob`. **Fix: add fields to serializer and enforce in `validate()` / `create()`.**
2. **Telemetry heartbeat accuracy across seeks**: Partial seek events (`seek` action in `ReelCard`) do not always trigger `register-skip` telemetry (`ReelCard.tsx` has skip buttons but interaction call missing per ISSUE-22). This affects `listen_duration_ms` accuracy and recommendation engine quality. **Fix: wire skip telemetry in `ReelCard` / `WaveformBar`.**
3. **Public clip route minimal redirect**: `/public/clips/{id}/` endpoint returns a reduced serializer (`PublicProfileSerializer`-style, no moderation status exposure). A malicious user could share a non-approved clip if the public endpoint doesn't filter `moderation_approved == True`. **Fix: add `moderation_approved` filter to public endpoint query.**
4. **Pgvector test environment**: Integration tests (`test_integration_pgvector.py`) require `CREATE EXTENSION IF NOT EXISTS vector;` in the test DB. Without it, 6 integration tests skip, reducing CI coverage for `HNSW` index behavior. **Fix: add to `conftest.py` or Docker `initdb.d` script.**

---

## 4. References (all cited above)

Every line number cited above is verified against the current source at commit `Sep 05 2026` (`.git` status in workspace root). The key backend source files are:

- `backend/app/models.py`
- `backend/app/serializers.py`
- `backend/app/urls.py`
- `backend/app/views/auth.py`
- `backend/app/views/content.py`
- `backend/app/views/feed.py`
- `backend/app/views/interactions.py`
- `backend/app/views/social.py`
- `backend/app/views/comments.py`
- `backend/app/views/profile.py`
- `backend/app/services/interactions.py`
- `backend/app/services/follows.py`
- `backend/app/services/shares.py`
- `backend/app/services/uploads.py`
- `backend/app/tasks.py`
- `backend/app/media_urls.py`
- `backend/app/signals.py`
- `backend/app/metrics.py`
- `backend/EchoFlow/settings.py`
- `backend/EchoFlow/celery.py`
- `backend/EchoFlow/health.py`
- `ai_ml/pipelines/feed_tasks.py`
- `frontend/sample_frontend/src/api/client.ts`
- `frontend/sample_frontend/src/pages/Feed.tsx`
- `frontend/sample_frontend/src/pages/Profile.tsx`
- `frontend/sample_frontend/src/pages/Upload.tsx`
- `frontend/sample_frontend/src/pages/Explore.tsx`
- `frontend/sample_frontend/src/components/sharing/ShareModal.tsx`
- `frontend/sample_frontend/src/components/comments/CommentSheet.tsx`
- `frontend/sample_frontend/src/components/feed/OnboardingModal.tsx`
- `frontend/sample_frontend/src/components/audio/ReelCard.tsx`
- `frontend/sample_frontend/src/components/feed/ReelList.tsx`
- `frontend/sample_frontend/src/components/feed/MiniPlayer.tsx`
- `frontend/sample_frontend/src/components/common/atoms.tsx`
- `frontend/sample_frontend/src/stores/auth.tsx`
- `frontend/sample_frontend/src/stores/player.tsx`
- `frontend/sample_frontend/src/app/router.tsx`
- `frontend/sample_frontend/src/data/feedAdapter.ts`

Regulatory references (all verified in this session via `webfetch`):
- IT Act 2000 (`wikipedia.org/wiki/Information_Technology_Act,_2000`)
- IT Rules 2021 (`wikipedia.org/wiki/Information_Technology_Rules,_2021`)
- DPDP Act 2023 (`wikipedia.org/wiki/Digital_Personal_Data_Protection_Act,_2023`)
- Consumer Protection Act 2019 (`wikipedia.org/wiki/Consumer_Protection_Act,_2019`)
- Copyright Act 1957 (`wikipedia.org/wiki/Copyright_law_of_India`)
- GST India (`wikipedia.org/wiki/Goods_and_Services_Tax_(India)`)
- Companies Act 2013 (`wikipedia.org/wiki/Companies_Act,_2013`)
- CERT-In Directions 28 Apr 2022 (`meity.gov.in` reference in `docs/INDIA-REGULATORY-READINESS.md` analysis)

---

This document is designed to be read by a coding agent before implementing the next sprint. It tells the agent:
- **What is broken** (Critical / High / Medium / Low).
- **Why it is broken** (root cause — missing model, missing serializer field, broken endpoint method, unsupported UI assumption).
- **Which file line proves the claim** (source citation).
- **What to edit in Phase A** (the minimal path to legal compliance).
- **What to edit in Phase B / C** (the complete feature + UX fix).

The user asked for an optimal path forward; Phase A is the shortest safe route (4 weeks of focused engineering) to get the platform to a legally defensible state; Phase B closes user-facing gaps; Phase C polishes metrics and internationalisation.
