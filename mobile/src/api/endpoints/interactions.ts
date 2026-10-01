import { z } from 'zod';

import { apiFetch } from '../client';

/**
 * Interaction endpoints — like, skip, telemetry. Thin and typed, mirroring
 * `endpoints/feed.ts` and `endpoints/auth.ts`: no state, no caching decisions,
 * no retry policy. The logic that *consumes* these (what the heart button
 * shows, when to fire a heartbeat, how to explain a refused write) lives in the
 * components and store.
 *
 * Routes, from backend/app/urls.py:76 (`ClipInteractionViewSet`,
 * `IsAuthenticated`, throttled):
 *   POST /interactions/{id}/toggle-like/      200 {"status":"liked"|"unliked"}
 *   POST /interactions/{id}/register-skip/    201 {"status":"skip/view registered"}
 *   POST /interactions/{id}/log-telemetry/    202 {"status":"telemetry logged"}
 *
 * EVERY route is auth-required; unauthenticated is 401.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SCHEMAS LIVE HERE, NOT IN ../schema.ts — DEVIATION FROM feed.ts, DELIBERATE
 * ─────────────────────────────────────────────────────────────────────────
 * `feed.ts` and `auth.ts` both import their schemas from the shared
 * `src/api/schema.ts`. That is the better convention and these should be
 * migrated there once the owner of that file is available; they are inline here
 * because this change was scoped to not touch it. The three response shapes
 * below are private to this module either way (no other endpoint returns
 * `{"status": "skip/view registered"}`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SILENT-SUCCESS TRAPS. Read this before trusting a 2xx from any of the three.
 * ─────────────────────────────────────────────────────────────────────────
 * A 2xx from this module means "the server accepted the request". For two of
 * the three it does NOT mean "the measurement was recorded". All four of these
 * are server-side facts, not client bugs, and none of them is visible in the
 * status code:
 *
 *  1. `reel_id` and `reel_position_ms` are REQUIRED BUT DISCARDED on
 *     register-skip. `SkipActionSerializer` (serializers.py:763-766) validates
 *     both — omitting `reel_id` is a 400 — but `register_skip`
 *     (views/interactions.py:134-139) reads only `listen_duration_ms` out of
 *     `validated_data` for the ranking math, and `reel_position_ms` is only
 *     passed along to a `record_skip` that never reads it either (the divisor
 *     moved to the server-side `clip.duration_ms` — services/interactions.py:
 *     252-268). So a well-formed request carrying garbage in both fields is a
 *     201 with no effect whatsoever. They are sent correctly here because a
 *     correct call costs nothing and a future server that starts reading them
 *     must not find them full of junk.
 *
 *  2. UNKNOWN EXTRA KEYS ARE SILENTLY DROPPED. DRF's `Serializer` ignores
 *     unrecognised fields, so a typo'd key (`action_tpye`) is not a 400 — it is
 *     a 2xx in which the server read *less* than you sent. A 202 is therefore
 *     not evidence that the payload you sent is the payload the server read.
 *
 *  3. A 201 on register-skip DOES NOT MEAN THE COMPLETION SAMPLE WAS RECORDED.
 *     `_completion_rate` (services/interactions.py:187-225) returns `None` for
 *     an over-claim — a `listen_duration_ms` past `clip.duration_ms` plus the
 *     2s/10% tolerance — and `record_skip` then increments `skips` but drops
 *     the sample entirely (`completion_sample_recorded: False`). The HTTP layer
 *     never sees that flag. `completion_rate` is 30% of the recommendation
 *     composite, so "201" and "the ranking learned something" are different
 *     claims; do not conflate them.
 *
 *  4. A `UserInteraction` TELEMETRY ROW IS WRITE-ONCE PER (user, clip).
 *     `unique_together = ('user', 'clip', 'interaction_type')` (models.py:269)
 *     plus `bulk_create(..., ignore_conflicts=True)` in the stream consumer
 *     (tasks.py:1011-1012) means only the FIRST heartbeat for a clip survives;
 *     later ones are no-ops. Do not build a caller that expects every sample to
 *     persist — the old web player's ~6s `timeupdate` fire rate produced roughly
 *     50 heartbeats per 300s clip, all but the first discarded.
 */

/* ------------------------------------------------------------------ */
/* Response schemas                                                     */
/* ------------------------------------------------------------------ */

/**
 * `toggle_like` derives the string from `interaction.is_active`
 * (views/interactions.py:125), so these are the only two possible values. A
 * third one would be a backend change and must fail here rather than render.
 *
 * There is deliberately NO like count in this type. The view returns only
 * `{'status': ...}`; the count lives on the clip (`FeedClip.likes`) and is
 * flushed to Postgres on a 5-minute Celery beat, so a count read here would be
 * stale and would disagree with `is_liked` anyway (see the `action_type`
 * comment on `logTelemetry` for a live case of exactly that).
 */
const likeResultSchema = z.object({
  status: z.enum(['liked', 'unliked']),
});
export type LikeResult = z.infer<typeof likeResultSchema>;

/** `{"status": "skip/view registered"}` — note the literal space (201). */
const skipResultSchema = z.object({
  status: z.literal('skip/view registered'),
});
export type SkipResult = z.infer<typeof skipResultSchema>;

/**
 * 202, NOT 200. `apiFetch` returns the parsed body and throws only on non-2xx
 * (client.ts:304-335), so 202 is an ordinary success by that contract and needs
 * no special handling here — but the distinction is recorded because the status
 * code is invisible to every caller, and "accepted for async write" is a
 * weaker promise than "written".
 */
const telemetryResultSchema = z.object({
  status: z.literal('telemetry logged'),
});
export type TelemetryResult = z.infer<typeof telemetryResultSchema>;

/* ------------------------------------------------------------------ */
/* Request types                                                        */
/* ------------------------------------------------------------------ */

/**
 * Register-skip input. Both fields are milliseconds and both are REQUIRED.
 *
 * `listenDurationMs` is ACCUMULATED WATCH TIME — the sum of time actually
 * played, not the media position and not the wall-clock age of the card. It is
 * the only one of the three body fields the server reads
 * (views/interactions.py:137), and it is the numerator of the completion rate,
 * which is 30% of the recommendation composite. Sending `position * 1000`
 * instead means a user who seeks to 0:55 of a 60s clip and skips one second
 * later reports a 0.92 completion — that is precisely the bug the old web
 * client shipped (`frontend/src/stores/player.tsx` sent
 * `listen_duration_ms == reel_position_ms == currentTime * 1000`).
 *
 * `reelPositionMs` is validated (`min_value=0`, no upper bound) and then
 * discarded; see silent-success trap 1. Send the true position.
 */
export type RegisterSkipInput = {
  listenDurationMs: number;
  reelPositionMs: number;
};

/**
 * Telemetry input. One field, on purpose — see `logTelemetry` for why the
 * `action_type` is not part of it.
 *
 * `watchTimeMs` is ACCUMULATED WATCH TIME and NEVER `currentTime * 1000`.
 * Server bound: `IntegerField(min_value=0, max_value=36_000_000)`
 * (serializers.py:820) — 10 hours, so the only client-visible bound worth
 * respecting is 0..36_000_000.
 */
export type LogTelemetryInput = {
  watchTimeMs: number;
};

/* ------------------------------------------------------------------ */
/* Endpoints                                                            */
/* ------------------------------------------------------------------ */

/**
 * Like / unlike a clip.
 *
 * ⚠️ THIS IS A TRUE TOGGLE, NOT AN IDEMPOTENT SET. There is no "set liked"
 * variant and no idempotency key: a second POST flips it back. So a retry after
 * a network timeout — a flaky connection, a user double-tapping, a TanStack
 * Query `retry: 1` — SILENTLY UNLIKES. Do not put this call behind anything
 * that re-issues it, and do not retry it on your own initiative. If you need
 * certainty, re-read `FeedClip.is_liked` rather than POSTing again.
 *
 * Sends NO BODY AT ALL. `toggle_like` never touches `request.data`
 * (views/interactions.py:121-126), and `apiFetch` only sets `Content-Type` when
 * a body is present (client.ts:249), so an empty body is also an empty header
 * set.
 *
 * 404 when the clip is outside the caller's interaction scope — not owned by
 * them AND not `moderation_approved` AND not licence-clean
 * (`get_queryset`, views/interactions.py:105-119). The scope is broader than
 * playback: an owner can interact with their own unmoderated clip, and a clip
 * shared with you is exempt from the licence filter.
 */
export async function toggleLike(clipId: string): Promise<LikeResult> {
  const raw = await apiFetch(`/interactions/${clipId}/toggle-like/`, {
    method: 'POST',
  });
  return likeResultSchema.parse(raw);
}

/**
 * Register a skip / a completed view.
 *
 * `reel_id` is REQUIRED by `SkipActionSerializer` (serializers.py:766) — its
 * absence is a 400 — and then thrown away, because `register_skip` never reads
 * it (views/interactions.py:134-139).
 *
 * It is derived from `clipId` INSIDE this function rather than accepted as a
 * parameter. A caller-supplied `reelId` would be a second UUID that could
 * disagree with the `clipId` already in the URL, and there is no version of
 * that disagreement the server could detect: the response is a 201 either way
 * and the field is discarded anyway. Deriving it makes the disagreement
 * unrepresentable instead of merely discouraged. (Reels are currently 1:1 with
 * clips; if that ever stops being true, the change belongs in a deliberate
 * signature edit here, where it is visible, not in a second argument at every
 * call site.)
 *
 * 201 does NOT mean the completion sample was recorded — silent-success trap 3.
 *
 * Throttle scope `interaction`, 60/min (settings.py:914).
 */
export async function registerSkip(
  clipId: string,
  input: RegisterSkipInput,
): Promise<SkipResult> {
  const raw = await apiFetch(`/interactions/${clipId}/register-skip/`, {
    method: 'POST',
    body: {
      listen_duration_ms: input.listenDurationMs,
      reel_position_ms: input.reelPositionMs,
      reel_id: clipId,
    },
  });
  return skipResultSchema.parse(raw);
}

/**
 * Log a watch-time heartbeat. Fed by the player's elapsed-playback accumulator,
 * never by media position.
 *
 * ── WHY `action_type` IS NOT A PARAMETER (the strongest guarantee here) ──
 * The server's `InteractionTelemetrySerializer.action_type` is a
 * `ChoiceField(choices=['view', 'like', 'share', 'skip'])`
 * (serializers.py:815). Three of those four choices are live data-corruption
 * primitives reachable from this endpoint, and all three are worse than they
 * look:
 *
 *   - `'like'` plants a `UserInteraction` row that `FeedClipSerializer
 *     .get_is_liked` then reports as a REAL like, while `AudioClip.likes` never
 *     moves (the counter is flushed to Postgres on a 5-minute Celery beat and
 *     this path does not increment it). The heart fills in, the count does not
 *     move, and the two disagree permanently — with no action that reconciles
 *     them.
 *   - `'skip'` feeds the −0.5 intent-weight penalty into the caller's OWN taste
 *     vector, so a single mislabelled heartbeat silently degrades the user's
 *     recommendations for that clip.
 *   - `'share'` fabricates a share event, which is a share of someone else's
 *     clip and therefore a rights/attribution claim about third-party audio.
 *
 * The only honest value from a passive watch-time heartbeat is `'view'`. Making
 * it a hardcoded literal inside this function means C9 (fabricated telemetry)
 * is not "a rule the caller must follow" but a rule the caller CANNOT express:
 * there is no call site, no prop and no store field that reaches it. Widening
 * `LogTelemetryInput` to a union would put the whole thing back.
 *
 * ── 403 IS PERMANENT AND PRECEDES THE CLIP LOOKUP ──
 * The DPDP §9 gate runs before `get_object()` (views/interactions.py:158-166),
 * so a minor gets 403 for a clip that does not exist either — a 403 here says
 * nothing about the clip, and nothing at all about whether it is real. It is
 * keyed on `is_minor`, which nothing can currently clear (there is no parental
 * verification flow), so it is not a "try again later". Stop firing heartbeats
 * for this account; see `isTelemetryRefusedForMinor`.
 *
 * ── 429 IS 60/min AND ESCAPES THE GLOBAL BUDGET ──
 * Scope `telemetry` is `60/min` (settings.py:889). `get_throttles` returns a
 * bare `[ScopedRateThrottle()]` for this action
 * (views/interactions.py:180-186), REPLACING the default
 * `AnonRateThrottle`/`UserRateThrottle`/`ScopedRateThrottle` list — so the
 * global `user` 1000/hour does not apply here at all. A player that fires on
 * every `timeupdate` will 429 within a minute of playback; throttle at the
 * call site, do not retry blindly.
 *
 * 400 → `{"<field>": ["<message>"]}`, e.g. `watch_time_ms` above 36_000_000.
 */
export async function logTelemetry(
  clipId: string,
  input: LogTelemetryInput,
): Promise<TelemetryResult> {
  const raw = await apiFetch(`/interactions/${clipId}/log-telemetry/`, {
    method: 'POST',
    body: {
      action_type: 'view',
      watch_time_ms: input.watchTimeMs,
    },
  });
  return telemetryResultSchema.parse(raw);
}

/* ------------------------------------------------------------------ */
/* Error classification                                                 */
/* ------------------------------------------------------------------ */

/**
 * Was this telemetry write refused because the account is under 18?
 *
 * STRUCTURAL, NOT `instanceof`. `client.ApiError` is read by duck-typing
 * `status` alone, which is what this predicate needs (it is the only field that
 * identifies the refusal) and it does not depend on there being exactly one
 * `ApiError` class instance in the process — under Metro's module duplication
 * or across a jest module mock boundary, `instanceof` is a boolean that flips
 * for reasons that have nothing to do with the response. `auth.ts` uses
 * `instanceof ApiError`; that is a deliberate difference, not an oversight.
 *
 * ⚠️ SCOPE — READ BEFORE CALLING. This returns true for a 403 from ANY source.
 * Within this module that is unambiguous, because `logTelemetry` is the only
 * action here that can produce a 403 (`toggle_like` and `register_skip` are
 * `IsAuthenticated`, so an unauthenticated caller gets 401, and an
 * out-of-scope clip gets 404 by design — views/interactions.py:100-103 says
 * 403 would confirm the clip exists). But an `ApiError` thrown by a call from
 * somewhere ELSE, such as the playback-token 403 for "unavailable/removed", is
 * NOT the minor refusal. Only feed an error caught around `logTelemetry`.
 */
export function isTelemetryRefusedForMinor(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  return (err as { status?: unknown }).status === 403;
}
