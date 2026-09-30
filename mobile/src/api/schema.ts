import { z } from 'zod';

/**
 * Response schemas — D5. Parse once at the API boundary.
 *
 * The backend has FOUR coexisting response envelopes, and guessing wrong is
 * silent rather than loud: `res.results` on a cursor page is `undefined`, which
 * renders as "no comments" rather than as an error. Each is named here.
 *
 *  1. PageNumber  {count, next, previous, results}   DRF PageNumberPagination
 *  2. Cursor      {next, previous, results}          NO `count`
 *  3. Hand-rolled  {results, ...} whose `next` may be the string "auto_trigger"
 *  4. Bare array  /share/inbox/ returns a top-level JSON array
 *
 * Plus two non-envelope shapes worth naming:
 *   - `GET /feed/` can return **202** with `retry_after_ms` (cold start)
 *   - `SubscriptionStatusSerializer.limits` is a DictField(child=CharField), so
 *     every value arrives as a **string** — including "60" for a duration.
 */

/* ------------------------------------------------------------------ */
/* Shared primitives                                                    */
/* ------------------------------------------------------------------ */

/** `next` is a URL when more pages exist and null otherwise — except in the
 *  hand-rolled envelope, where it can be the literal string "auto_trigger". */
const nextOrSentinel = z.union([z.string(), z.null()]).optional();

/* ------------------------------------------------------------------ */
/* 1. PageNumberPagination — {count, next, previous, results}           */
/* ------------------------------------------------------------------ */

/** DRF's PageNumberPagination. `count` is the distinguishing field. */
export function pageNumberSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    count: z.number(),
    next: z.string().nullable(),
    previous: z.string().nullable(),
    results: z.array(item),
  });
}

/* ------------------------------------------------------------------ */
/* 2. CursorPagination — {next, previous, results}, NO count           */
/* ------------------------------------------------------------------ */

/**
 * `backend/app/views/comments.py:40-80` uses CommentCursorPagination with
 * page_size=20 and -created_at ordering. The absence of `count` is the whole
 * discriminator vs. envelope 1 — so this schema is deliberately strict about
 * it (`.strict()` on the object below would reject a `count` and surface a
 * backend change rather than silently accepting either shape).
 */
export function cursorSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    next: z.string().nullable(),
    previous: z.string().nullable(),
    results: z.array(item),
  });
}

/* ------------------------------------------------------------------ */
/* 3. Hand-rolled {results, ...} with a sentinel `next`                 */
/* ------------------------------------------------------------------ */

/**
 * Used by the suggestions/feed style responses, where `next` is sometimes the
 * string literal "auto_trigger" rather than a URL. Parsed as string|null so
 * neither shape throws.
 */
export function handRolledSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    next: nextOrSentinel,
    results: z.array(item),
  });
}

/** The literal sentinel the backend uses for "ask again to trigger". */
export const AUTO_TRIGGER = 'auto_trigger';

/* ------------------------------------------------------------------ */
/* 4. Bare top-level array — /share/inbox/                             */
/* ------------------------------------------------------------------ */

/**
 * `/share/inbox/` returns a top-level array, not an envelope. The old client
 * defensively accepted both (api.ts:209-211); this schema keeps that
 * defensiveness but makes it explicit and typed.
 */
export function bareArraySchema<T extends z.ZodTypeAny>(item: T) {
  return z.array(item);
}

/* ------------------------------------------------------------------ */
/* GET /feed/ — 200 envelope or 202 cold-start                          */
/* ------------------------------------------------------------------ */

/** FeedClip fields, per FeedClipSerializer. tags/duration_ms added in B5. */
export const feedClipSchema = z.object({
  id: z.string(),
  title: z.string(),
  creator_name: z.string(),
  creator_id: z.number(),
  category: z.string(),
  hls_playlist_url: z.string().nullable(),
  likes: z.number(),
  shares: z.number(),
  skips: z.number(),
  comment_count: z.number(),
  is_liked: z.boolean(),
  /**
   * Phase 3 (2026-09-30): `FeedClipSerializer.get_is_following` has sent this
   * since c9405ae (serializers.py:626, :641, :656, :678-702) and the web client
   * reads it — but zod STRIPS undeclared keys, so every mobile call site was
   * receiving `undefined` and the follow button had no server value to hydrate
   * from. That is the original defect in a new place: a button initialised to
   * `false` on someone already followed silently UNFOLLOWS them on the first
   * press, a real FK mutation with no confirmation and no error.
   *
   * Optional, and it must stay optional: `GET /suggestions/` and the
   * `feedClipSchema` reuse across older payloads do not guarantee it, and a
   * required field would reject a whole page over a follow button. `null` means
   * "the server did not say", which the follow state machine treats as
   * unpressable rather than as false.
   */
  is_following: z.boolean().nullish(),
  /** B5 (2026-09-29): added to FeedClipSerializer; makes the scrubber exact
   *  instead of derived from the player. */
  duration_ms: z.number().optional(),
  /** B5: added to FeedClipSerializer for tag chips. */
  tags: z.array(z.string()).optional(),
});
export type FeedClip = z.infer<typeof feedClipSchema>;

export const feedOkSchema = handRolledSchema(feedClipSchema).extend({
  queue_health: z.number().optional(),
  degraded: z.boolean().optional(),
});

/**
 * 202 cold-start marker. `retry_after_ms` is a *server hint* (1500ms) — the
 * client must honour it rather than inventing its own backoff.
 *
 * Kept as a single definition; it was previously duplicated as
 * `feedDegradedSchema` (byte-identical, referenced only by its own test).
 * @see docs/FRONTEND-REQUIREMENTS.md §4.8
 */
export const feedDegradedSchema = z.object({
  retry_after_ms: z.number().optional(),
  detail: z.string().optional(),
  degraded: z.boolean().optional(),
});
export type FeedDegraded = z.infer<typeof feedDegradedSchema>;

/**
 * A `GET /feed/` response, whichever status it arrived with.
 *
 * WHY THIS UNION EXISTS: `apiFetch` returns the parsed body and throws on
 * non-2xx, so **the HTTP status is not available to the caller** — 200 and 202
 * are both "success" by that contract. The two are told apart by their SHAPE
 * instead, in `parseFeedResponse`, so no caller has to re-derive it.
 *
 * The alternative — teaching `apiFetch` to surface `status` — would change
 * every existing call site's return type for the benefit of one endpoint, so
 * the discrimination is kept local.
 */
export const feedDegradedMarkerSchema = z.object({
  retry_after_ms: z.number().optional(),
  detail: z.string().optional(),
  degraded: z.boolean().optional(),
});

export type FeedResponse =
  | { kind: 'ok'; clips: FeedClip[]; queueHealth: number; degraded?: boolean }
  | { kind: 'cold'; retryAfterMs: number };

/**
 * Parse a `GET /feed/` body into a discriminated result.
 *
 * The discriminator is the **presence of `retry_after_ms`**, and it has to be.
 *
 * The previous version gated the cold branch on the *absence* of `results`,
 * on the documented belief that "a 202 carries no results at all". That is
 * false. `views/feed.py:92-100` returns:
 *
 *     {"results": [], "message": "Preparing your feed...",
 *      "retry_after_ms": 1500, "degraded": true}
 *
 * `results: []` is present, so `Array.isArray([])` is true, the cold branch
 * was skipped entirely, and the body parsed as a normal *empty* 200 page.
 * Verified by running the real body through the old code:
 *
 *     REAL 202  -> {"kind":"ok","clips":[],"queueHealth":0,"degraded":true}
 *
 * Every downstream consequence was live and silent:
 *   - `retry_after_ms` was never read, so the server's cool-down hint was
 *     never honoured (the entire point of the 202);
 *   - `coolingDown` never became true, so the "finding more for you" state was
 *     unreachable;
 *   - a brand-new user's personalised feed never arrived — the first cold
 *     load set zero clips and nothing ever re-requested, dropping them onto
 *     the cold-start fallback for the whole session;
 *   - once the buffer sat between 1 and 14 clips, the refill effect re-armed
 *     on every `loading` toggle with no delay: a tight `lpop` loop against a
 *     drained queue, each iteration publishing another `refill_user_feed`
 *     Celery task.
 *
 * `retry_after_ms` is the correct discriminator because it is **unique to the
 * 202**: neither the primary 200 (`views/feed.py:123-127`) nor the degraded
 * trending 200 (`views/feed.py:148-153`) sets it. `degraded` alone is
 * ambiguous — both 200 fallbacks set it — and `results` is not a discriminator
 * at all, since an empty `results` is legal in both.
 *
 * A malformed body has neither `retry_after_ms` nor `results`, so it falls
 * through to the strict 200 parse and throws. A 500 never reaches here at all
 * (`apiFetch` throws `ApiError` on non-2xx), so a DRF error body is not
 * misread as a cold start.
 */
export function parseFeedResponse(raw: unknown): FeedResponse {
  const cold = feedDegradedMarkerSchema.safeParse(raw);
  if (cold.success && cold.data.retry_after_ms != null) {
    return { kind: 'cold', retryAfterMs: cold.data.retry_after_ms };
  }

  const ok = feedOkSchema.parse(raw);
  return {
    kind: 'ok',
    clips: ok.results,
    queueHealth: ok.queue_health ?? 0,

    degraded: ok.degraded,
  };
}

/**
 * `POST /media/playback-token/{id}/` — the native transport.
 *
 * `token` is present ONLY when the request sent `X-EchoFlow-Client: native`.
 * Without that header the body is `{"status":"ok"}` and the credential travels
 * as an HttpOnly cookie, which a native player cannot use (it has no shared
 * cookie jar). So on this platform a missing `token` is a CONTRACT VIOLATION,
 * not a soft no-op — hence `.refine` rather than `.optional()`.
 */
export const playbackTokenSchema = z
  .object({
    status: z.literal('ok'),
    token: z.string().min(1),
  })
  .refine((v) => v.status === 'ok', { message: 'playback token: unexpected status' });
export type PlaybackToken = z.infer<typeof playbackTokenSchema>;

/* ------------------------------------------------------------------ */
/* Auth                                                                 */
/* ------------------------------------------------------------------ */

/** `POST /auth/login/` and `/auth/token/refresh/` both return this. */
export const tokenPairSchema = z.object({
  access: z.string(),
  refresh: z.string(),
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

/**
 * `POST /auth/register/` returns 201 with a User and **no tokens** — by design,
 * not a bug (`serializers.py` Meta.fields is username/password/email/
 * consent_accepted/terms_version/dob/parent_email, with password and email
 * `write_only`). The client must follow up with a separate login call.
 * @see docs/FRONTEND-REQUIREMENTS.md §9
 */
export const registerUserSchema = z.object({
  username: z.string(),
  dob: z.string().optional(),
  is_minor: z.boolean().optional(),
  parent_email: z.string().nullable().optional(),
});

/* ------------------------------------------------------------------ */
/* GET /legal/compliance/ — AllowAny, needed before login               */
/* ------------------------------------------------------------------ */

/**
 * `views/legal.py:12-51`. Fetched at registration-screen mount so
 * `terms_version` is never hardcoded — `RegisterSerializer.terms_version` is
 * required and validated against `settings.TERMS_VERSIONS`, so a client that
 * cannot read the list has to guess and 400s the day a version is appended.
 * Scope 'legal' is 30/hour and IP-keyed: fetch once, never poll.
 */
export const legalComplianceSchema = z.object({
  compliance_officer: z.object({ name: z.string(), email: z.string() }),
  grievance_officer: z.object({ name: z.string(), email: z.string() }),
  nodal_contact: z.object({ name: z.string(), email: z.string() }),
  terms_versions: z.array(z.string()),
  current_terms_version: z.string(),
  privacy_version: z.string(),
  physical_address: z.string(),
});
export type LegalCompliance = z.infer<typeof legalComplianceSchema>;

/* ------------------------------------------------------------------ */
/* GET /profile/me/                                                     */
/* ------------------------------------------------------------------ */

export const ownProfileSchema = z.object({
  id: z.number(),
  username: z.string(),
  email: z.string().optional(),
  profile_picture: z.string().nullable().optional(),
  followers_count: z.number().optional(),
  following_count: z.number().optional(),
  uploads_count: z.number().optional(),
  liked_clips: z.array(feedClipSchema).optional(),
  date_joined: z.string().optional(),
  is_minor: z.boolean().optional(),
});
export type OwnProfile = z.infer<typeof ownProfileSchema>;

/* ------------------------------------------------------------------ */
/* Comments — cursor envelope                                          */
/* ------------------------------------------------------------------ */

export const commentSchema = z.object({
  id: z.string(),
  clip: z.string(),
  author_username: z.string(),
  /** B7 (2026-09-29): added to CommentSerializer so authors are linkable. */
  author_id: z.number().optional(),
  parent: z.string().nullable(),
  text: z.string(),
  reply_count: z.number().optional(),
  created_at: z.string(),
});
export type Comment = z.infer<typeof commentSchema>;

/* ------------------------------------------------------------------ */
/* Subscription — limits values are ALL strings                         */
/* ------------------------------------------------------------------ */

/**
 * `SubscriptionStatusSerializer.limits` is `DictField(child=CharField)`, so
 * `max_clip_duration_seconds` arrives as the **string** "60", not the number 60.
 * The app must coerce explicitly; a truthiness check on "60" is fine but
 * arithmetic on it silently concatenates.
 */
export const subscriptionStatusSchema = z.object({
  is_pro: z.boolean(),
  expires_at: z.string().nullable().optional(),
  grace_until: z.string().nullable().optional(),
  limits: z.record(z.string(), z.string()).optional(),
});
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

/** Coerce a string limit to a number, or null when absent/unparseable. */
export function limitNumber(
  limits: Record<string, string> | undefined,
  key: string,
): number | null {
  const raw = limits?.[key];
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
