import { z } from 'zod';

import { apiFetch } from '../client';

/**
 * Share endpoints — find a listener, send them a clip. Thin and typed, mirroring
 * `endpoints/interactions.ts` and `endpoints/social.ts`: no state, no debouncing,
 * no retry policy. The logic that *consumes* these (what the sheet shows, when a
 * send is admissible, how a refusal is told from a failure) lives in
 * `src/lib/shareDraft.ts`.
 *
 * SCOPE. SHARE ONLY, in its own module. `endpoints/social.ts` owns follow and
 * says so in its own docstring; the two have unrelated id spaces (trap 1 below)
 * and a single `socialAPI` would invite passing the wrong one — which on this
 * module's `find-user` is an unhandled 500 and on `send-share` is a `ShareEvent`
 * row in the wrong person's inbox.
 *
 * Routes, from backend/app/urls.py (`ShareViewSet`, `permissions.IsAuthenticated`):
 *   GET  /share/find-user/?username=<q>
 *        200 {"id": <int>, "username": "<str>"}      views/social.py:191
 *        400 {"error": "Username required"}
 *        400 {"error": "You can't share with yourself"}
 *        404 {"error": "No user found: @<q>"}
 *        409 {"error": "More than one account matches…"}
 *   POST /share/{clip_uuid}/send-share/
 *        201 {"status": "shared successfully"}        views/social.py:250
 *        400 {"error": "Receiver ID required"} | {"error": "You can't share with yourself"}
 *        403 {"error": "This clip may not be shared"}
 *        404 {"detail": "Not found."}
 *
 * Auth-required; unauthenticated is 401.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SCHEMAS LIVE HERE, NOT IN ../schema.ts — SAME DEVIATION AS interactions.ts
 * ─────────────────────────────────────────────────────────────────────────
 * `feed.ts` and `auth.ts` import from the shared `src/api/schema.ts`; the
 * `interactions.ts` agent set the precedent of declaring a module-private schema
 * for a private response shape, and this follows it deliberately. `find-user`'s
 * `{"id": …}` is returned by no other endpoint in the app, so putting it in a
 * file another agent owns would be a merge surface for nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TRAP 1 — TWO ID SPACES, AND ONE OF THEM IS AN INTEGER pk
 * ─────────────────────────────────────────────────────────────────────────
 * `find-user` returns `id: user.id` — an INTEGER `User.pk` (`views/social.py:191`).
 * `send-share` takes it in a body field `receiver_id`
 * (`views/social.py:219`, `get_object_or_404(User, id=receiver_id)` at `:230`).
 * The clip in the same flow is a UUID (`AudioClip.id`, a `z.string()` in
 * `feedClipSchema` — `api/schema.ts:100`).
 *
 * `get_object_or_404` catches `Model.DoesNotExist` and nothing else. A non-numeric
 * pk raises `ValueError` out of the queryset — an **unhandled 500**, not a 404
 * and not a 400. So passing a clip UUID as `receiver_id` is not a validation
 * error the caller can recover from; it is a server-side exception. `receiverId`
 * is typed `number` here and the `ShareRecipient` schema below is `z.number()`,
 * so the wrong id cannot be handed in through the type system — and the
 * endpoint tests assert the runtime agrees.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TRAP 2 — `send-share` IS A POST, AND THE OLD CLIENT SENT A GET
 * ─────────────────────────────────────────────────────────────────────────
 * `@action(detail=True, methods=['post'], url_path='send-share')`
 * (`views/social.py:193`) answers a GET with **405**, and it did so for months
 * against a client that sent one — the scar comment lives at
 * `frontend/src/api/client.ts:707`. Nothing about that is subtle now, but it is
 * worth recording because the endpoint is `@action` on a `GenericViewSet`, which
 * makes "the collection also has a POST" feel true: `POST /share/` is a 405 too
 * (`ShareViewSet` is `GenericViewSet + List + Retrieve + Destroy` — the default
 * `create` mixin was removed precisely because it crashed, `views/social.py:7-13`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TRAP 3 — NOT IDEMPOTENT. NEVER RETRY, NEVER DOUBLE-PRESS.
 * ─────────────────────────────────────────────────────────────────────────
 * `services/shares.py:31` is an unconditional `ShareEvent.objects.create`. There
 * is no dedupe, no idempotency key and no unique constraint on
 * `(sender, receiver, clip)`. A second successful POST is a SECOND unread inbox
 * row for a stranger plus a SECOND increment of `AudioClip.shares`
 * (`record_share`), and the server will never tell you about the first.
 *
 * The ONE re-issue that is safe is `apiFetch`'s built-in 401-refresh-and-replay
 * (`client.ts:314-322`), and it is safe for the same structural reason as
 * `toggle-like`: the 401 is raised in `APIView.initial()` before `dispatch()`
 * reaches `send_share`, so the replay is the first execution. Do not add a retry
 * of your own — not on a 5xx, not on a timeout, not on a double-tap. The
 * per-`(clipId, recipientId)` in-flight guard in `lib/shareDraft.ts` is the
 * client-side half of this.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TRAP 4 — TWO ERROR KEYS ON ONE ENDPOINT
 * ─────────────────────────────────────────────────────────────────────────
 * `find-user` and `send-share` report failures under `error` when the VIEW raises
 * them, and under `detail` when DRF's `get_object_or_404` does
 * (`{"detail": "Not found."}`, `views/social.py:230, 238`). Both keys are live on
 * `send-share`: an unknown receiver is `detail`, an NC clip is `error`. A caller
 * that reads only `error` renders NOTHING for every 404 — the failure mode is a
 * blank sheet, not a wrong message. `shareErrorMessage` reads both, in that
 * order, and is the only place in the app that should do so.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THROTTLE — `share_poll` 1000/hour IS A REAL BUDGET, BUT NOT FOR A HUMAN
 * ─────────────────────────────────────────────────────────────────────────
 * `ShareViewSet.get_throttles` returns a bare `[ScopedRateThrottle()]` for
 * `send_share` (`views/social.py:101-111`), which REPLACES the default throttle
 * list, so `send-share` draws ONLY on `share_send` = **100/hour**
 * (`settings.py:1013`) and not on the global `user: 1000/hour`. `find-user` keeps
 * the default list and lands on `share_poll` = **1000/hour** (`settings.py:1014`),
 * which the view's docstring sizes for a client polling an inbox every 3.6 s
 * (1000/3600 ≈ 0.28/s).
 *
 * This sheet is submit-driven, not polled, so a person looking up a name uses a
 * handful of `share_poll` requests an hour and the arithmetic is not a concern.
 * Recorded because the number looks like a per-minute budget and is not: the trap
 * is building a debounced auto-search that fires on every keystroke, which turns a
 * typo into six requests. One request per submit is the rule.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LICENCE GATING, AND WHAT 403 DOES *NOT* MEAN
 * ─────────────────────────────────────────────────────────────────────────
 * `send-share` refuses a clip where `is_license_restricted` — `is_noncommercial` or
 * `requires_share_alike` (`views/social.py:239-247`). Sharing **your own** clip is
 * allowed and is the point of the feature; the filter above it is
 * `status='ready' AND moderation_approved=True` (`:233-236`), not a
 * not-my-clip rule.
 *
 * The 403 fires AFTER the receiver lookup and AFTER the clip lookup, so it is a
 * real answer about a real clip — unlike the DPDP §9 403 on `log-telemetry`, which
 * precedes its clip lookup and therefore says nothing about the clip. See
 * `isShareLicenceRefused` for why the copy must still not say which of the two
 * rights flags it was.
 */

/* ------------------------------------------------------------------ */
/* Response schemas                                                     */
/* ------------------------------------------------------------------ */

/**
 * The one person `find-user` resolved.
 *
 * `id` is an INTEGER `User.pk`. **`.int().positive()` is tighter than the brief's
 * `z.number()`, deliberately**: the column is a Django `AutoField`, so no stored
 * row has a fractional or non-positive pk, and a float that reached
 * `get_object_or_404(User, id=2.5)` would raise rather than 404 — the same
 * `ValueError`-not-`DoesNotExist` trap as a UUID string. Rejecting it here is the
 * difference between a loud failure in a test and a 500 in production.
 *
 * zod `.object()` strips undeclared keys, so a future field on this response is
 * dropped rather than rendered. For a two-key identity object that is the right
 * direction to fail in: a caller cannot be corrupted by a field it cannot see.
 */
const shareRecipientSchema = z.object({
  id: z.number().int().positive(),
  username: z.string(),
});
export type ShareRecipient = z.infer<typeof shareRecipientSchema>;

/**
 * `{"status": "shared successfully"}` — note the two words. The string is NOT
 * `"shared"`, and matching on the HTTP code instead is impossible:
 * `apiFetch` returns the parsed body and throws on non-2xx (`client.ts:304-335`),
 * so no caller of this module can observe 201 at all. Switch on the literal.
 *
 * There is no `share_id`, no `receiver`, and no count of shares the clip now has.
 * The server sends `{'status': …}` and nothing else (`views/social.py:250`), and a
 * count would have to come from `FeedClip.shares`, which is flushed on a 5-minute
 * Celery beat and would be stale for four minutes.
 */
const sendShareResultSchema = z.object({
  status: z.literal('shared successfully'),
});
export type SendShareResult = z.infer<typeof sendShareResultSchema>;

/* ------------------------------------------------------------------ */
/* Client-side bounds                                                   */
/* ------------------------------------------------------------------ */

/**
 * The longest query worth sending: `User.username` is `varchar(150)`
 * (`views/social.py:127`).
 *
 * A longer query cannot match a stored name — `iexact` compares the whole string
 * — so every request over the bound is a guaranteed 404. And the 404 is
 * self-defeating at scale: the view interpolates the query into the body
 * (`f'No user found: @{username}'`, `:172`), so a 10 000-character paste comes
 * back as a 10 016-character error string that this client would then render.
 *
 * `findShareUser` throws before the request when the trimmed query is longer, so
 * the bound holds even for a caller that skips the sheet's own
 * `normaliseUsernameQuery`. Both read this constant; there is one number.
 */
export const FIND_USER_MAX_QUERY = 150;

/* ------------------------------------------------------------------ */
/* Endpoints                                                            */
/* ------------------------------------------------------------------ */

/**
 * Resolve one username to one `User.pk`.
 *
 * **The ONLY user directory in this codebase.** There is no peer list, no contact
 * list, no "people you follow" endpoint — a sheet that needs a recipient has to
 * ask for a name. `frontend/src/components/sharing/ShareModal.tsx` shipped four
 * hardcoded "Network Peers" carrying real `User` pks 1-4; one tap wrote a
 * `ShareEvent`, bumped the share counter and dropped an unread inbox item into a
 * stranger's account, then rendered a green "Sent". That is `651ac0c`.
 *
 * The match is `username__iexact` (`views/social.py:169`), so **the returned
 * `username` is the STORED spelling, not what was typed.** `ALICE` finds `alice`
 * and the sheet must render `alice`; rendering the query back would claim to a
 * stranger that you know a name you actually guessed at the case of.
 *
 * Exact match only: one character of partial input is a 404. There is no
 * `startswith` fallback to hint at near-misses, because a hint is a list of
 * strangers' accounts.
 *
 * Errors, all under `error` (the view raises them itself; there is no
 * `get_object_or_404` on this path):
 *   400 empty/whitespace — `{"error": "Username required"}`
 *   400 yourself        — `{"error": "You can't share with yourself"}`
 *   404 unknown         — `{"error": "No user found: @<query>"}`
 *   409 ambiguous       — see `isShareAmbiguousUsername`
 *   429 over `share_poll: 1000/hour`
 *
 * Sends no body and no method — a plain GET, like `getFeedPage`.
 *
 * ⚠️ 409 IS NOT AN EDGE CASE, IT IS A REACHABLE DATA STATE, AND IT MUST NOT FALL
 * THROUGH TO A GENERIC MESSAGE. `User.username` is `unique=True` on a
 * case-SENSITIVE column (`views/social.py:123-127` records the check:
 * `SELECT 'alice' = 'Alice'` is false, `'alice' ILIKE 'Alice'` is true), so
 * `alice` and `Alice` are both storable and `iexact` matches both. The view
 * slices at 2 and refuses rather than picking a winner (`:174-186`) — returning
 * the lowest `pk` would deliver the share to whichever row was registered first,
 * which is exactly the row a name-squatter controls. Every 409 in this codebase
 * should read as "this name is ambiguous, ask for the exact spelling", not as
 * "the search failed".
 */
export async function findShareUser(username: string): Promise<ShareRecipient> {
  const query = username.trim();
  // Both refusals happen BEFORE `apiFetch`, so an unreachable bound is a
  // programming error caught in the caller's own test suite rather than a 404
  // that costs `share_poll` budget and returns a 10 KB message.
  if (query.length === 0) {
    throw new Error(`findShareUser: empty username (see ${FIND_USER_MAX_QUERY} for the bound)`);
  }
  if (query.length > FIND_USER_MAX_QUERY) {
    throw new Error(
      `findShareUser: username is ${query.length} characters; ` +
        `User.username is varchar(${FIND_USER_MAX_QUERY}) so it cannot match`,
    );
  }
  const raw = await apiFetch(
    `/share/find-user/?username=${encodeURIComponent(query)}`,
  );
  return shareRecipientSchema.parse(raw);
}

/**
 * Send this clip to one recipient.
 *
 * POST, never GET — trap 2 in the module docstring. A GET is a 405.
 *
 * `receiverId` MUST be an integer `User.pk` that came out of `findShareUser`.
 * Passing `FeedClip.id` is an unhandled 500 (trap 1), and passing a *fabricated*
 * integer writes a real inbox row for whoever owns it — which is what the
 * hardcoded peer list did. The type is `number` and the sheet's only source of
 * one is the parsed `find-user` body; there is no prop, field or parameter that
 * reaches a different value.
 *
 * Sharing **your own** clip is allowed and is the feature. An NC or SA clip is
 * 403 by design.
 *
 * NOT IDEMPOTENT — trap 3. Never retry, never auto-retry, and never let a second
 * press through while the first is outstanding.
 */
export async function sendShare(
  clipId: string,
  receiverId: number,
): Promise<SendShareResult> {
  const raw = await apiFetch(`/share/${clipId}/send-share/`, {
    method: 'POST',
    body: { receiver_id: receiverId },
  });
  return sendShareResultSchema.parse(raw);
}

/* ------------------------------------------------------------------ */
/* Error classification                                                 */
/* ------------------------------------------------------------------ */

/** The HTTP status on a rejection, or `undefined` when there was no response. */
function errorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * A message the SERVER meant for a human, from either error key.
 *
 * `error` first, `detail` second — the view's own messages are the specific ones
 * ("This clip may not be shared"), and `detail` is DRF's generic
 * `"Not found."` from `get_object_or_404`.
 *
 * Two rejections never become copy, and both would be actively harmful if they
 * did: a non-JSON 5xx body parsed as an HTML error page, and `ApiError`'s own
 * default `message` of `"API error 500"`. Neither is a diagnosis. `ApiError`
 * also carries `Retry-After` in `message` for a 429, which is why the 429 branch
 * in `lib/shareDraft.ts` does not use this helper at all.
 *
 * STRUCTURAL, NOT `instanceof` — the same argument, and the same deliberate
 * difference from `auth.ts`, that `isTelemetryRefusedForMinor` and
 * `isFollowSelfRefusal` make. It reads `body` off the thrown value by
 * duck-typing, which keeps it correct across Metro's module duplication and a
 * jest module-mock boundary, where `instanceof` is a boolean that flips for
 * reasons unrelated to the response.
 */
export function shareErrorMessage(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const body = (err as { body?: unknown }).body;
  if (typeof body !== 'object' || body === null) return null;
  for (const key of ['error', 'detail'] as const) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    // An HTML error page is a symptom, never a message.
    if (trimmed.startsWith('<')) return null;
    return trimmed;
  }
  return null;
}

/**
 * Is this a 409 — the ambiguous-username answer from `find-user`?
 *
 * ⚠️ SCOPE: `find-user` only. Nothing else in the app answers 409 today, and the
 * playback-token view has one of its own (`media not ready`), which is NOT this
 * refusal. Only feed it an error caught around `findShareUser`.
 *
 * Structural, like the other predicates here: `status === 409`, duck-typed.
 */
export function isShareAmbiguousUsername(err: unknown): boolean {
  return errorStatus(err) === 409;
}

/**
 * Did the server refuse because the recipient is you?
 *
 * Matched on **400 AND the server's own sentence** (`views/social.py:190` and
 * `:226`, which are byte-identical), read out of either error key — not on the
 * status alone. A status-only predicate would also be true for `find-user`'s other
 * 400 (`"Username required"`), and that 400 says the opposite thing: the user has
 * to type something, not stop typing their own name. The two 400s need different
 * copy and only the message tells them apart.
 *
 * The 400 half is the belt to that braces: nothing else in the app emits this
 * sentence, so requiring the code only rejects a hypothetical future 403 that
 * happened to quote it. Cheap, and it keeps the predicate's answer tied to the
 * one endpoint pair that produces it.
 *
 * The comparison is `includes` rather than `===` so a wrapped or re-punctuated
 * copy still classifies, while a different sentence on the same key does not.
 */
export function isShareSelfRefusal(err: unknown): boolean {
  if (errorStatus(err) !== 400) return false;
  const message = shareErrorMessage(err);
  return message !== null && message.includes("You can't share with yourself");
}

/**
 * Was this send refused because the clip's rights forbid sharing it?
 *
 * 403 from `send-share` is exactly that and nothing else: the view has no other
 * 403 (`views/social.py:239-247`), and it fires AFTER the receiver and clip
 * lookups, so unlike the DPDP §9 403 on `log-telemetry` this one is a real answer
 * about a real clip.
 *
 * ⚠️ The MESSAGE must not distinguish `is_noncommercial` from
 * `requires_share_alike`, and must not say either. It does not have to: the
 * server sends one sentence for both (`"This clip may not be shared"`,
 * `views/social.py:245`), and a client that turned a 403 into "this clip is
 * non-commercial" would be telling a caller holding only a UUID something about
 * the licensing state of someone else's audio. `cardStatusReport`
 * (`ReelCard.tsx:331-342`) collapses its two 403 causes for exactly this reason
 * and this copy follows it.
 */
export function isShareLicenceRefused(err: unknown): boolean {
  return errorStatus(err) === 403;
}

/**
 * Did the server 500 because an id was not the shape it must be?
 *
 * ⚠️ HONEST LIMITATION, stated here rather than papered over: a 500 on
 * `send-share` is the `ValueError` from `get_object_or_404` when `receiver_id` is
 * not an integer, **or** when the path's clip pk is not a UUID
 * (`views/social.py:230, 238`) — the two are indistinguishable from the response,
 * and neither is the other's fault. This predicate therefore does NOT claim to
 * know which. Its job is narrower and achievable: it tells the sheet that the
 * failure is a malformed id rather than a transient fault, so the message can say
 * "this clip cannot be shared" instead of "try again", which would be a lie
 * because a retry produces the same 500.
 *
 * It is the last line of defence, not the mechanism. Neither bad id can be
 * constructed from this module: `ShareRecipient.id` is `z.number().int().positive()`
 * and `clipId` is `FeedClip.id`, a `z.string()` UUID. This exists so that if a
 * future caller ever does construct one, the user is told something true.
 */
export function isShareReceiverIdUnusable(err: unknown): boolean {
  return errorStatus(err) === 500;
}
