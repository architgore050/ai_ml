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
 * 202 cold-start. `retry_after_ms` is a *server hint* (1500ms default) — the
 * client must honour it rather than inventing its own backoff.
 * @see docs/FRONTEND-REQUIREMENTS.md §4.8
 */
export const feedDegradedSchema = z.object({
  retry_after_ms: z.number().optional(),
  detail: z.string().optional(),
  degraded: z.boolean().optional(),
});
export type FeedDegraded = z.infer<typeof feedDegradedSchema>;

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
