import { z } from 'zod';

import { apiFetch } from '../client';

/**
 * Social-graph endpoints — follow/unfollow. Thin and typed, mirroring
 * `endpoints/interactions.ts`: no state, no debouncing, no retry policy. The
 * logic that *consumes* this (what the button reads, when a press is allowed,
 * how a refusal is told from a failure) lives in `src/lib/followState.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SCOPE. FOLLOW ONLY. The share endpoints (`/share/find-user/`,
 * `/share/{clip_uuid}/send-share/`, `/share/inbox/`) live on the SAME
 * `ShareViewSet`/`FollowViewSet` neighbourhood in `views/social.py` and are
 * specified in the same place, but they are a different agent's file and are
 * deliberately NOT here. Do not grow this module into `socialAPI`; the two have
 * unrelated id spaces (below) and merging them would invite exactly the bug this
 * docstring exists to prevent.
 *
 * Route, from backend/app/urls.py:79 (`FollowViewSet`,
 * `permissions.IsAuthenticated`, no explicit throttles):
 *   POST /follow/{user_pk}/toggle-follow/
 *     201 {"status": "followed"}
 *     200 {"status": "unfollowed"}
 *     400 {"error": "You cannot follow yourself."}
 *     404 {"detail": "Not found."}
 *
 * Auth-required; unauthenticated is 401.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TRAP 1 — THE PATH SEGMENT IS AN INTEGER `User.pk`, WHILE `FeedClip.id` IN THE
 * SAME FEED ROW IS A UUID. READ THIS TWICE.
 * ─────────────────────────────────────────────────────────────────────────
 * `get_object_or_404(User, pk=pk)` (`views/social.py:288`) is the ONLY place
 * `pk` is used, and `get_object_or_404` catches `Model.DoesNotExist` and
 * nothing else. A non-numeric `pk` therefore raises `ValueError` out of
 * `User.objects.get()` — an **unhandled 500**, not a 404, not a 400. Passing
 * `clip.id` where the creator's id belongs turns every follow press into a 500.
 *
 * The id to use is `FeedClip.creator_id`, which the shared schema types as
 * `z.number()` (`src/api/schema.ts:103`) — a plain JS number, so `userId` is
 * typed `number` and not `string`. `FeedClip.id` is `z.string()`
 * (`schema.ts:101`). Two id spaces in one feed row; they are not
 * interchangeable, and nothing in the type system stops you from passing the
 * wrong one to a template literal.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TRAP 2 — READ THE `status` STRING. THE HTTP CODE IS NOT AN OPTION.
 * ─────────────────────────────────────────────────────────────────────────
 * The two directions are distinguished by the code (201/200) AND by the string,
 * and they can disagree — the same body is legal on either code, and a proxy or
 * a future view can pair any code with either string. More importantly the code
 * is **not reachable**: `apiFetch` returns the parsed body and throws on
 * non-2xx (`client.ts:304-335`), so no caller of this module can observe the
 * status code at all. `FollowResult` is therefore `{status: 'followed' |
 * 'unfollowed'}` and nothing else, and the code cannot be branched on even by
 * accident.
 *
 * This is not a style preference. The old web client's button initialised to
 * `false` instead of reading the server's `is_following`, so it showed "Follow"
 * on someone already followed and the tap **silently unfollowed them** — a real
 * FK mutation with no confirmation and no error. `FeedClipSerializer
 * .get_is_following` (`serializers.py:678-702`) was added to make the honest
 * state available; a client that does not read it is back to the defect.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TRAP 3 — A TRUE TOGGLE, NO IDEMPOTENCY KEY, NO SERVER-SIDE CONCURRENCY GUARD.
 * ─────────────────────────────────────────────────────────────────────────
 * `services/follows.py:16-22` is a read-then-write on the M2M with no locking:
 *
 *     16:  if actor.following.filter(pk=target.pk).exists():
 *     17:      actor.following.remove(target)
 *     19:  actor.following.add(target)
 *
 * There is no `desired_state` field and no body to carry one, so two in-flight
 * POSTs for the same pair **net to zero** — both see `exists() == False`, both
 * `add`, and the user watched the button not move. Two requests also cost two
 * `User.following` row operations against a table the client cannot re-read
 * cheaply (the count lives on `GET /profile/{id}/`, a second request).
 *
 * The ONE re-issue that is safe is `apiFetch`'s built-in 401-refresh-and-replay
 * (`client.ts:314-322`), and it is safe for the same structural reason as
 * `toggle-like`: DRF raises the 401 in `APIView.initial()`
 * (`perform_authentication`), which runs before `dispatch()` reaches the action,
 * so the replay is the *first* execution of the toggle. Do not add a retry of
 * your own — not on a 5xx, not on a timeout, not on a double-tap.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THROTTLING — THERE IS NONE, AND THAT IS THE CLIENT'S PROBLEM TO SOLVE.
 * ─────────────────────────────────────────────────────────────────────────
 * `FollowViewSet` (`views/social.py:280-296`) declares no `throttle_classes`,
 * so it inherits `DEFAULT_THROTTLE_CLASSES` (settings.py:876-880), which
 * includes `ScopedRateThrottle`. `ScopedRateThrottle.allow_request` reads the
 * scope off the **view** and returns `True` immediately when there is none
 * (`rest_framework/throttling.py:219-225`):
 *
 *     221:  self.scope = getattr(view, self.scope_attr, None)
 *     224:  if not self.scope:
 *     225:      return True
 *
 * So the scoped throttle is a **silent no-op**, not an error — the exact
 * footgun `AGENTS.md` records under `ScopedRateThrottle`. What is left:
 *
 *   - `AnonRateThrottle` (`anon: 100/hour`) does **not** bind. It is skipped
 *     outright for an authenticated caller: `AnonRateThrottle.get_cache_key`
 *     returns `None` when `request.user.is_authenticated`
 *     (`throttling.py:173-175`).
 *   - `UserRateThrottle` (`user: 1000/hour`) is the only limit, keyed on
 *     `request.user.pk` (`throttling.py:238-249`).
 *
 * 1000/hour against an endpoint that only reads one M2M row is generous, and it
 * is also 1000 chances to waste someone else's time with a runaway retry loop.
 * **Every bit of debouncing is the client's responsibility** — see
 * `src/lib/followState.ts`, whose in-flight guard is the only thing standing
 * between a double-tap and a silent unfollow.
 */

/* ------------------------------------------------------------------ */
/* Response schemas                                                     */
/* ------------------------------------------------------------------ */

/**
 * The ONLY two strings the server can produce, so this is an enum and not a
 * `z.string()`. `toggle_follow` returns the literal `result` of
 * `follows_svc.toggle_follow`, which is `'followed'` or `'unfollowed'` and
 * nothing else (`views/social.py:293-294`, `services/follows.py:16-22`).
 *
 * There is deliberately **NO follower count in this type**, and that is not an
 * omission to fix later. The view returns `{'status': result}` and nothing
 * else. `followers_count` is an `IntegerField(read_only=True)` annotated onto
 * the profile serializer (`serializers.py:1063`) and reaches the client only via
 * `GET /profile/{id}/`. Modelling a count here would be a count of nothing: a
 * client that invented one would have to either guess or issue a second request
 * per press, and the guess would be permanently inconsistent with the server's
 * (which is computed from a DB aggregate, not from the M2M row the toggle
 * touched). Keep the count on the profile endpoint, where it is true.
 *
 * One consequence worth knowing, because the instinct is to expect a REJECTION:
 * zod's `.object()` **strips** undeclared keys rather than failing on them, so a
 * future `followers_count` on this response would be dropped silently and the
 * parsed result would still be `{status}`. For a toggle that is the right
 * direction to fail in — a caller cannot be corrupted by a field it cannot see —
 * and the tripwire is an `Object.keys` assertion on the RESULT, not on the wire
 * body. (`cursorSchema` in `api/schema.ts:44-60` wants `.strict()` for the
 * opposite reason: there the extra key is what tells you which envelope shape
 * arrived, and either reading is actionable.)
 */
const followResultSchema = z.object({
  status: z.enum(['followed', 'unfollowed']),
});
export type FollowResult = z.infer<typeof followResultSchema>;

/** The two directions, named — what `src/lib/followState.ts` reasons about. */
export type FollowStatus = FollowResult['status'];

/* ------------------------------------------------------------------ */
/* Endpoints                                                            */
/* ------------------------------------------------------------------ */

/**
 * Follow or unfollow a user. A **toggle**: call it once per press.
 *
 * ⚠️ `userId` is an INTEGER `User.pk` (`FeedClip.creator_id`, a `z.number()`),
 * NOT the clip's UUID. See trap 1 in the module docstring — passing
 * `FeedClip.id` here is an unhandled 500, because `get_object_or_404(User,
 * pk=…)` catches `DoesNotExist` and a non-numeric `pk` raises `ValueError`
 * instead.
 *
 * Sends NO BODY AT ALL. `toggle_follow` never reads `request.data`
 * (`views/social.py:290-296`), and `apiFetch` only sets `Content-Type` when a
 * body is present (`client.ts:249`), so an empty body is also an empty header
 * set.
 *
 * Returns the server's own string — 201 and 200 carry the same shape and the
 * code is invisible to this module. See trap 2.
 *
 * Errors:
 *   400 `{"error": "You cannot follow yourself."}` — trailing period. Refusing
 *       self-follow is correct behaviour, not a failure: see
 *       `isFollowSelfRefusal`. It is also prevented client-side, because a
 *       button that can be pressed to produce a guaranteed error is a bug.
 *   401 not signed in · 404 no such user · 429 over `user: 1000/hour`
 *
 * Note what is NOT here: no 403. Unlike `log-telemetry` (which refuses minors
 * outright, `views/interactions.py:158-166`), `toggle_follow` has no
 * age gate — following is open to minors by omission, not by decision, but
 * nothing in this view reads `is_minor`.
 */
export async function toggleFollow(userId: number): Promise<FollowResult> {
  const raw = await apiFetch(`/follow/${userId}/toggle-follow/`, {
    method: 'POST',
  });
  return followResultSchema.parse(raw);
}

/* ------------------------------------------------------------------ */
/* Error classification                                                 */
/* ------------------------------------------------------------------ */

/**
 * Was this follow refused because the target is the caller?
 *
 * STRUCTURAL, NOT `instanceof` — the same argument, and the same deliberate
 * difference from `auth.ts`, that `isTelemetryRefusedForMinor` makes. It
 * duck-types `status` alone, which is the only field that identifies the
 * refusal, and that keeps the predicate correct across Metro's module
 * duplication and a jest `mock('../client')` boundary, where `instanceof` is a
 * boolean that flips for reasons unrelated to the response.
 *
 * ⚠️ SCOPE — 400 FROM *THIS* ENDPOINT ONLY, and read before calling it. 400 is
 * a generic DRF code: `register-skip` and `log-telemetry` both produce 400 for
 * a body the serializer rejected, and `PlaybackTokenView` produces 400 for a
 * malformed id. Only feed this an error caught around `toggleFollow`, where 400
 * is unambiguous — `toggle_follow` is the only action in this module and the
 * view reads no request data at all, so there is no other 400 it can be.
 *
 * Why a caller needs to tell it apart at all, given `followState.ts` refuses a
 * self-follow locally: the local refusal is a **best-effort** guard keyed on
 * `viewerId`, and a caller that has not loaded the viewer's own pk (or whose
 * `viewerId` is stale) will let the press through. The server's answer is the
 * authority, and it is a refusal rather than a failure: nothing failed, nothing
 * needs retrying, and rendering it as "could not update follow" would be a lie.
 */
export function isFollowSelfRefusal(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  return (err as { status?: unknown }).status === 400;
}