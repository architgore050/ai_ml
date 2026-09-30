import { isFollowSelfRefusal } from '../api/endpoints/social';

/**
 * The follow button's state machine, as pure functions.
 *
 * This is the layer the original defect lived in, and it is a data-corruption
 * bug rather than a rendering one, so the rules below are ordered by how much
 * they cost when violated.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DEFECT: THE BUTTON NEVER ASKED THE SERVER
 * ─────────────────────────────────────────────────────────────────────────
 * The old web card initialised its button to `false` rather than reading
 * `is_following`. So on a creator the viewer already followed it rendered
 * "Follow", and pressing it issued the toggle against a relationship that was
 * already there — which **silently unfollowed them**. Not a wrong colour and not
 * a rejected request: a real `User.following` row deleted, no confirmation, no
 * error, no undo. `FeedClipSerializer.get_is_following` (`serializers.py:678`,
 * with the `user_is_following` `Exists` fast path at `:97-129`) was added
 * specifically to make the honest state available on the feed row.
 *
 * Hence rule 1 below: **the server's `is_following` is the seed, and a state
 * with no server value is not `false`.** It is `null` — "unknown" — and the
 * button cannot press it. Collapsing unknown to `false` is the defect wearing a
 * different hat, and it is not hypothetical here: see the note on
 * `hydrateFollowState` about `feedClipSchema`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THESE FUNCTIONS EXIST AT ALL RATHER THAN BEING `useState`
 * ─────────────────────────────────────────────────────────────────────────
 * Three of the rules are about **interleavings**, and a `useState` reducer
 * cannot express them testably: a press during a request, a rollback that must
 * not clobber a newer press, an error that is a value rather than a throw.
 * Written as plain functions over a plain object, all three are ordinary
 * statements in a test. Nothing here performs I/O, reads a clock, or touches
 * React — `pressFollow` hands back the request id the caller must quote back
 * when the promise settles, and that is the entire async protocol.
 *
 * The ABA hazard (rule 3, `isCurrentRequest`) is the part worth reading twice;
 * it is what this file exists for.
 */

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

/** What the server can say. Mirrors `FollowStatus` in `api/endpoints/social.ts`. */
export type FollowStatus = 'followed' | 'unfollowed';

/**
 * The pre-press value, tagged with the press that captured it.
 *
 * The tag is the whole point. Restoring an *unconditional* saved value is the
 * bug this type exists to prevent — see `isCurrentRequest`.
 */
export type FollowRollback = {
  requestId: number;
  isFollowing: boolean;
};

/**
 * One follow button's state.
 *
 * `isFollowing` is `boolean | null` and `null` means **"no server value yet"**,
 * not `false`. See the defect write-up above; collapsing it is a one-character
 * change that reintroduces the unfollow.
 */
export type FollowState = {
  /**
   * The creator being followed, as an integer `User.pk` — `FeedClip.creator_id`,
   * a `z.number()` (`api/schema.ts:103`), NOT the clip UUID `FeedClip.id`.
   * `null` when the clip carried no usable creator id, or none at all.
   */
  userId: number | null;
  /** The signed-in viewer's own pk, for the local self-follow refusal. */
  viewerId: number | null;
  /** Server truth, or the optimistic value while a request is outstanding. */
  isFollowing: boolean | null;
  /**
   * A request is outstanding. Distinct from BOTH `isFollowing` and `error` so
   * the button can show a spinner over the value it already has, rather than
   * blanking it — the web client's fix used to blank the button and rename it.
   */
  pending: boolean;
  /** Errors are a value, not an exception. The store convention. */
  error: string | null;
  /** Monotonically increasing identity of the newest press. Never reused. */
  requestId: number;
  /** The value to restore if THAT press fails, or null when none is outstanding. */
  rollback: FollowRollback | null;
};

/**
 * The outcome of a press. A discriminated union rather than a boolean so a
 * caller that forgets to check one cannot silently get the other: `'sent'` means
 * a request is now in flight and the id must be quoted back on settle.
 */
export type FollowPress =
  | { kind: 'sent'; state: FollowState; requestId: number }
  | { kind: 'ignored'; state: FollowState; reason: FollowIgnoreReason }
  | { kind: 'refused'; state: FollowState; reason: 'self-follow' };

/** Why a press did nothing. `in-flight` is the one that saves you. */
export type FollowIgnoreReason = 'in-flight' | 'no-target' | 'unknown-state';

/* ------------------------------------------------------------------ */
/* Messages                                                             */
/* ------------------------------------------------------------------ */

/**
 * The refusal copy. Matches the server's own string
 * (`views/social.py:291`) so a caller that surfaces the message the client
 * generated and one that surfaces the server's body do not differ by a full
 * stop — and, more usefully, so this export is greppable against the backend.
 */
export const FOLLOW_SELF_REFUSAL_MESSAGE = 'You cannot follow yourself.';

/**
 * The generic failure copy. Deliberately the web client's wording
 * (`frontend/src/test/reelCard.test.tsx` asserts `/could not update follow/i`)
 * so the two clients do not drift into two different promises about retrying.
 */
export const FOLLOW_FAILED_MESSAGE = 'Could not update follow. Please try again.';

/* ------------------------------------------------------------------ */
/* Coercion — one boundary, so "coerce at the boundary" is meaningful    */
/* ------------------------------------------------------------------ */

/**
 * A usable `User.pk`, or null.
 *
 * `Number.isSafeInteger` is the test and not `isNaN` or `Number.isInteger`, for
 * three reasons. `isNaN(Infinity)` is `false` and `Infinity` as a path segment is
 * a 500 (see trap 1 in `api/endpoints/social.ts`). `Number.isInteger` accepts
 * `2**53`, which is an integer in the floating-point sense but has no reliable
 * neighbours — it cannot round-trip an integer primary key through a URL and
 * back, so accepting it would let a caller address a row by a number no row has.
 * And `isSafeInteger` rejects a **string**, which is what makes "the caller
 * passed `FeedClip.id`" a *no-op* rather than a 500: the string never becomes a
 * `userId`, `pressFollow` returns `'no-target'`, and no request is made. The
 * type already forbids that; this makes the runtime agree.
 *
 * `> 0` rejects the `0` a hand-built state or a not-yet-persisted user can
 * produce.
 */
function usableUserId(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * A server-supplied `is_following`, or `null` for "unknown".
 *
 * `=== true` / `=== false` only. A truthy `1` or the string `'true'` is not a
 * value the server sends; treating either as `true` would re-create the defect
 * for a shape nobody produced.
 */
function usableIsFollowing(value: unknown): boolean | null {
  return value === true ? true : value === false ? false : null;
}

/**
 * Is `requestId` the id of the press that is still outstanding?
 *
 * ── THE ABA HAZARD, and why a comparison is the only honest guard ──
 * A rollback that restores an unconditional saved value is wrong whenever the
 * user has pressed again since. The concrete shape:
 *
 *     seed is_following = false
 *     press #1  -> optimistic true,  rollback = {1, false}
 *     press #2  -> optimistic false, rollback = {2, true}
 *     failure for #1 arrives late
 *
 * Unconditional rollback restores `true` — it reverts the SECOND press to
 * satisfy the FIRST one's failure, and the button ends up showing "Following"
 * for a creator the user is not following. `isFollowing` is now wrong and no
 * further action can fix it: the next press sends a toggle, not a set.
 *
 * Note that the value is not merely stale, it is *doubly* wrong — `true` is
 * both the pre-press value of a different press AND the opposite of what the
 * user last asked for.
 *
 * The guard is `requestId` equality rather than a boolean `pending`, because
 * `pending` cannot distinguish "this press" from "some press". A settled
 * request that arrives late has already cleared `pending`, and a boolean would
 * happily revert the newer press.
 *
 * Why two requests can be outstanding at once, given the in-flight guard: with
 * `pending` strictly enforced, they cannot. This guard is therefore defence in
 * depth for callers that legitimately re-enable the button before the promise
 * settles — a debounce window that closes on a timer, a gesture handler and a
 * keyboard handler both wiring `onPress`, a `finally` that clears `pending` on an
 * unmounted path, or a retry that re-enters through here. All of those are
 * ordinary code to write, none of them is a bug, and every one of them turns an
 * unguarded rollback into a wrong button. The guard costs one integer compare.
 */
function isCurrentRequest(state: FollowState, requestId: number): boolean {
  return (
    state.rollback !== null &&
    state.rollback.requestId === requestId &&
    requestId === state.requestId
  );
}

/* ------------------------------------------------------------------ */
/* Entry points                                                         */
/* ------------------------------------------------------------------ */

/**
 * Seed a button from a feed row.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * `isFollowing` IS TAKEN EXPLICITLY AND IS NOT READ OFF `clip`, AND THAT IS A
 * KNOWN GAP, NOT A PREFERENCE.
 * ─────────────────────────────────────────────────────────────────────────
 * The backend sends it: `is_following` is in `FeedClipSerializer.Meta.fields`
 * (`serializers.py:626, :641, :656`), computed from the `user_is_following`
 * `Exists` annotation (`serializers.py:97-129`), and every queryset that
 * serialises a list annotates it, so it costs the fast path and no extra round
 * trip. The web client reads `clip.is_following` directly.
 *
 * **The mobile shared schema does not declare it.** `feedClipSchema`
 * (`src/api/schema.ts:99-117`) has `is_liked` and no `is_following`, and zod's
 * `.object()` strips undeclared keys — so the value is dropped at the parse
 * boundary and `FeedClip` has no such property. `schema.ts` is owned by
 * someone else and is out of scope here, so rather than read a field the type
 * does not have (which would need a cast and would silently become `undefined`
 * the day the schema changes), the server value is threaded in explicitly and
 * the omission is stated where the next agent will hit it.
 *
 * **When `isFollowing` is `undefined` the state is `isFollowing: null`, i.e.
 * unusable — and today, with this schema, that is every call site.** That is
 * deliberate. `false` would make every press a coin-flip against a relationship
 * the server never told us about, which is the original defect with the
 * hydration step removed. The button shows nothing pressable until a caller
 * supplies the value (a `GET /profile/{id}/` that carries `is_following`, or a
 * `feedClipSchema` edit). This is reported as an open item, not worked around.
 *
 * Total: every combination of a hostile `creator_id`, a hostile `viewerId` and a
 * hostile `isFollowing` yields a valid state. `NaN`, `Infinity`, `-1`, `0`,
 * `1.5`, `null`, `undefined` and a UUID string all become `null` ids, which
 * makes `pressFollow` return `'no-target'` rather than build a URL that 500s.
 */
export function hydrateFollowState(input: {
  /** The feed row whose creator is being followed, or null when there is none. */
  clip?: { creator_id?: number | null } | null;
  /** The signed-in viewer's own pk. Without it the self-follow guard is inert. */
  viewerId?: number | null;
  /** `FeedClipSerializer.is_following`. `undefined`/`null` ⇒ unknown, NOT false. */
  isFollowing?: boolean | null;
}): FollowState {
  return {
    userId: usableUserId(input.clip?.creator_id),
    viewerId: usableUserId(input.viewerId),
    isFollowing: usableIsFollowing(input.isFollowing),
    pending: false,
    error: null,
    requestId: 0,
    rollback: null,
  };
}

/**
 * The user pressed the button.
 *
 * ## Check order, and why self-follow is FIRST
 *
 *  1. **`no-target`** — there is no usable integer creator id. Nothing can be
 *     addressed, so nothing is sent. This is what a `NaN`/`0`/UUID-string
 *     `creator_id` produces.
 *  2. **`self-follow`** — the target IS the viewer. Checked before `in-flight`
 *     because admissibility is not a function of what else is happening: an
 *     inadmissible press can never become admissible by waiting, and `'refused'`
 *     is the more informative answer than `'ignored'`. It also matches where the
 *     server puts the check — `toggle_follow` compares before touching the M2M
 *     (`views/social.py:290-292`) — so the two agree on ordering.
 *     **No request is made.** A button that can be pressed to produce a
 *     guaranteed 400 is a bug, not a feature: the request would cost throttle
 *     budget, burn a round trip, and surface an error for something the client
 *     already knew.
 *  3. **`in-flight`** — a request is outstanding. This is the rule that makes
 *     this endpoint's "true toggle with no idempotency key" survivable: two
 *     toggles net to zero (`services/follows.py:16-22`), so the second press must
 *     not become a second request. **`'ignored'`, never `'queued'`** — a queued
 *     second toggle would fire the instant the first settled and silently undo
 *     it, and the user would see the button do nothing and then the opposite of
 *     what they pressed. An ignored press is honestly ignored.
 *  4. **`unknown-state`** — `isFollowing` is `null`. Guessing the direction of a
 *     toggle on a relationship the server has not described is how you unfollow
 *     someone. Refuse.
 *
 * Otherwise: flip optimistically, set `pending`, clear the previous error, mint
 * the next `requestId`, and record the pre-press value **tagged with that id**
 * for the rollback.
 *
 * Pure: `state` is never mutated, and the returned state is the only thing the
 * caller should install.
 */
export function pressFollow(state: FollowState): FollowPress {
  if (state.userId === null) {
    return { kind: 'ignored', state, reason: 'no-target' };
  }

  if (state.viewerId !== null && state.userId === state.viewerId) {
    // The value is NOT flipped. The relationship was never changed, so there is
    // nothing to roll back and no reason to claim one.
    return {
      kind: 'refused',
      state: { ...state, error: FOLLOW_SELF_REFUSAL_MESSAGE },
      reason: 'self-follow',
    };
  }

  if (state.pending) {
    return { kind: 'ignored', state, reason: 'in-flight' };
  }

  if (state.isFollowing === null) {
    return { kind: 'ignored', state, reason: 'unknown-state' };
  }

  // `isFollowing` is narrowed to boolean by the check above.
  const requestId = usableRequestId(state.requestId) + 1;
  return {
    kind: 'sent',
    requestId,
    state: {
      ...state,
      isFollowing: !state.isFollowing,
      pending: true,
      error: null,
      requestId,
      rollback: { requestId, isFollowing: state.isFollowing },
    },
  };
}

/**
 * The request the caller sent succeeded.
 *
 * `status` is the SERVER'S STRING, and the HTTP status code is not a parameter
 * and cannot be — `apiFetch` returns the parsed body and throws on non-2xx
 * (`client.ts:304-335`), so the code is unreachable from here. That is the
 * structural half of the "read the string, not the code" rule; the behavioural
 * half is below.
 *
 * A success sets `isFollowing` from `status`, never from "the press I intended".
 * They are the same value in the ordinary case and they are NOT the same value
 * when the client's local state was wrong — which is exactly the situation that
 * produces the original defect, so this is where the server's answer has to win.
 *
 * A stale `requestId` is a no-op in BOTH directions: it does not move
 * `isFollowing` and it does not clear `pending`, because a newer press owns the
 * outstanding request. See `isCurrentRequest`.
 */
export function confirmFollow(
  state: FollowState,
  requestId: number,
  status: FollowStatus,
): FollowState {
  if (!isCurrentRequest(state, requestId)) return state;
  return {
    ...state,
    isFollowing: status === 'followed',
    pending: false,
    error: null,
    rollback: null,
  };
}

/**
 * The request the caller sent failed.
 *
 * Restores the pre-press value captured by THAT press, and only when the id
 * still matches. Both halves of that sentence are load-bearing:
 *
 *  - "captured by THAT press" — an unconditional restore reverts a newer press.
 *    See `isCurrentRequest` for the worked example.
 *  - "only when the id still matches" — a failure arriving when nothing is
 *    outstanding (a stray, a state rebuilt from a cache, a duplicated effect
 *    run) must leave `isFollowing` alone. Rolling back with no rollback to
 *    restore from would otherwise have to invent a value.
 *
 * `pending` clears even when the rollback is a no-op, so a stuck spinner cannot
 * outlive the request that caused it.
 *
 * `err` is duck-typed via `isFollowSelfRefusal`, never `instanceof`, and the
 * predicate is IMPORTED rather than restated — two 400 classifiers in one app is
 * how a 400 for a malformed clip id starts rendering as "you cannot follow
 * yourself".
 */
export function failFollow(
  state: FollowState,
  requestId: number,
  err: unknown,
): FollowState {
  if (!isCurrentRequest(state, requestId)) {
    // Someone else's press owns the outstanding request. Clearing `pending`
    // here would hand the button back while a real request is still in flight,
    // which is precisely the double-toggle the in-flight guard exists to stop.
    return state;
  }
  return {
    ...state,
    isFollowing: state.rollback?.isFollowing ?? state.isFollowing,
    pending: false,
    rollback: null,
    error: describeFollowError(err),
  };
}

/* ------------------------------------------------------------------ */
/* Internals                                                            */
/* ------------------------------------------------------------------ */

/**
 * A message for a thrown value, for the `error` field.
 *
 * Total: anything that is not the self-follow refusal becomes the generic
 * failure message. `err` is `unknown` because that is what a `catch` binds and
 * what a rejected promise carries — typing it `Error` would be a lie the first
 * time a rejected value is a string or a `DOMException`.
 */
export function describeFollowError(err: unknown): string {
  return isFollowSelfRefusal(err) ? FOLLOW_SELF_REFUSAL_MESSAGE : FOLLOW_FAILED_MESSAGE;
}

/**
 * The next id is always a finite integer one above a valid one.
 *
 * Unreachable through the public API — `requestId` only ever increments from 0
 * — but `FollowState` is a plain exported object, so a hand-built or
 * persisted-and-restored state can carry `NaN`, and `NaN + 1` is `NaN`, which
 * would make `isCurrentRequest` compare `NaN === NaN` and permanently fail,
 * wedging the button on "pending" for the life of the component. Same reasoning
 * as `interactionGuard`'s overflow guard: a property the type claims is enforced
 * rather than assumed.
 */
function usableRequestId(value: number): number {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}