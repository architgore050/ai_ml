import {
  FIND_USER_MAX_QUERY,
  isShareAmbiguousUsername,
  isShareLicenceRefused,
  isShareReceiverIdUnusable,
  isShareSelfRefusal,
  shareErrorMessage,
  type ShareRecipient,
} from '../api/endpoints/share';

/**
 * The share sheet's state, as pure functions.
 *
 * This is the layer the original defect lived in, and it was a data-corruption
 * bug rather than a rendering one: `frontend/src/components/sharing/ShareModal.tsx`
 * shipped four hardcoded "Network Peers" carrying **real `User` primary keys
 * 1-4**. One tap on "Stream" wrote a `ShareEvent`, incremented `AudioClip.shares`
 * and dropped an unread inbox item into a stranger's account — and then rendered
 * a green "Sent". Fixed in `651ac0c`; this file exists so it cannot come back.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY FUNCTIONS AND NOT `useState`
 * ─────────────────────────────────────────────────────────────────────────
 * The rules below are about **interleavings and admissibility**, and a `useState`
 * reducer cannot express them as testable statements: a press during a request,
 * a response that arrives after the sheet was dismissed, a send with no
 * recipient. Written as plain functions over a plain object, each is one
 * assertion. Nothing here performs I/O, reads a clock, or touches React —
 * `startSend` hands back the key the caller must quote back when the promise
 * settles, and that is the entire async protocol.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE INVARIANT THIS FILE EXISTS TO ENFORCE
 * ─────────────────────────────────────────────────────────────────────────
 * **A `receiver_id` can only ever come from a parsed `find-user` response.**
 * There is no peer list in this codebase, no contact list, no suggestions
 * endpoint, and no "people you follow" endpoint — `GET /share/find-user/` is the
 * only user directory and it is exact-match (`views/social.py:169`). So the
 * recipient lives in ONE place, `ShareDraftState.recipient`, whose type is
 * `ShareRecipient` — an `id` that `z.number().int().positive()` produced from a
 * response body (`api/endpoints/share.ts`). A clip UUID cannot inhabit that type,
 * and a hand-written integer cannot either: there is no prop, no parameter and no
 * store field that accepts one.
 *
 * Three independent refusals stand in front of it, in order of how much they cost
 * if they are removed:
 *
 *  1. `startSend` returns `'no-recipient'` and the caller makes no request. This
 *     is the load-bearing one and it is asserted directly.
 *  2. The sheet renders no send control at all until a recipient exists, so there
 *     is nothing to press.
 *  3. The handler takes no argument. Even a buggy `onPress` cannot supply an id,
 *     because there is no parameter for it to supply.
 *
 * An honest empty state is the only alternative to inventing a peer list, and
 * inventing one is precisely what the old client did.
 */

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

/**
 * One `(clip, recipient)` pair.
 *
 * Clip-scoped for the reason `frontend`'s `shareKey` documents: a sheet that
 * outlives a close (mounted once by the feed, `visible` flipped) would otherwise
 * mark the NEXT clip's row "Sent" after a share for the previous one, and a
 * response that lands after a close-and-reopen would write a key the new sheet
 * reads. With the clip in the key, a late settle writes a key nothing is showing.
 */
export type ShareSendKey = string;

/**
 * The sheet's whole state. Small on purpose: it is a record of what the SERVER
 * told us (one recipient, or none) plus the local bookkeeping that cannot be
 * re-derived from it.
 */
export type ShareDraftState = {
  /**
   * The clip this sheet is sharing. Part of every key. Not a mutable field the
   * UI can drift: `emptyShareDraft` takes it and the sheet re-creates its state
   * whenever it changes (see `ShareModal`'s mount-per-open rule).
   */
  clipId: string;
  /**
   * The one person `find-user` resolved, or `null`. **The only source of a
   * `receiver_id` in this app.** `null` is the initial state and the state after
   * any failed or refused search — never "a guess" and never "the typed name".
   */
  recipient: ShareRecipient | null;
  /** `find-user` refused. A search failure CLEARS the recipient, so a row from a
   *  previous search cannot be sent after the user has been told it is stale. */
  searchError: string | null;
  /** In-flight sends, by key. A record rather than a boolean because the guard is
   *  per `(clipId, recipientId)` — an in-flight send to one person must not block
   *  a different one. */
  pendingKeys: Readonly<Record<string, true>>;
  /**
   * Sends that succeeded. LOCAL ONLY — see `confirmSend`.
   *
   * The server has no "what have I sent" endpoint: `GET /share/` is the
   * RECIPIENT's inbox, filtered `receiver=request.user` (`views/social.py:90`),
   * so a sender cannot read back what they sent. A client that treated this map
   * as the truth would be claiming a fact it cannot check, which is why
   * `RESEND_NOTICE` tells the user plainly that a second send creates a second
   * inbox item.
   */
  sentKeys: Readonly<Record<string, true>>;
  /** `send-share` refused. Rendered next to the send control. */
  sendError: string | null;
};

/** What the user typed, normalised. `kind` is the only thing a caller branches on. */
export type UsernameQuery =
  | { kind: 'empty' }
  | { kind: 'too-long'; length: number; max: number }
  | { kind: 'ready'; query: string };

/** The outcome of pressing "search". `refused` means NO REQUEST was made. */
export type SearchBegin =
  | { kind: 'ready'; state: ShareDraftState; query: string }
  | { kind: 'refused'; state: ShareDraftState; message: string };

/**
 * The outcome of pressing "send".
 *
 * A discriminated union, not a boolean, so a caller that forgets to check one
 * cannot silently get the other: `'sent'` means a request is now in flight and
 * the key must be quoted back on settle.
 */
export type ShareSendAttempt =
  | { kind: 'sent'; state: ShareDraftState; key: ShareSendKey; recipient: ShareRecipient }
  | { kind: 'ignored'; state: ShareDraftState; reason: ShareSendIgnoreReason }
  | { kind: 'refused'; state: ShareDraftState; message: string };

/** Why a press did nothing. `in-flight` is the one that saves you. */
export type ShareSendIgnoreReason = 'no-recipient' | 'in-flight' | 'already-sent';

/* ------------------------------------------------------------------ */
/* Copy                                                                 */
/* ------------------------------------------------------------------ */

/**
 * The HTTP status on a rejection, or `undefined` when there was no response.
 *
 * `0` COUNTS AS NO RESPONSE. `apiFetch` maps a transport failure — a dead
 * connection, an aborted timeout — to `ApiError({status: 0})` (`client.ts:284`),
 * and DRF uses 0 as a "no handler" code. Treating it as an ordinary status sends
 * it through every branch to the generic copy, which is the precise failure the
 * old client had: telling the user their username is wrong when the problem is
 * their connection.
 */
function errorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/** No HTTP response at all — a network failure, a timeout, or a bare throw. */
function hasNoResponse(err: unknown): boolean {
  const status = errorStatus(err);
  return status === undefined || status === 0;
}

/**
 * DRF's boilerplate, which is never worth showing.
 *
 * `get_object_or_404` raises `Http404` and DRF renders it as `{"detail": "Not
 * found."}` (`views/social.py:230, 238`). That is a *mechanism* — the lookup
 * missed — not a sentence, and it is strictly less useful than our own copy,
 * which says what to do next. `find-user` raises every one of its own errors
 * under `error` (`views/social.py:166-190`) and never produces a `detail`, so on
 * this path a `detail` is boilerplate by construction.
 */
function isBoilerplate(message: string): boolean {
  return /^not found\.?$/i.test(message);
}

/**
 * The clip cannot be shared, said WITHOUT saying why.
 *
 * The same rule `cardStatusReport` applies when it collapses its two 403 causes
 * (`ReelCard.tsx:331-342`): a caller holding only a UUID learns nothing about
 * moderation or licensing state, so a message that distinguished
 * `is_noncommercial` from `requires_share_alike` would be disclosing someone
 * else's rights metadata. `ActionCluster`'s share label ("Share unavailable for
 * this clip") obeys the same rule, and this is the sheet half of it.
 */
export const SHARE_UNAVAILABLE_COPY = 'This clip cannot be shared.';

/**
 * The search's empty result, and the reason there is nothing else here.
 *
 * `find-user` is exact-match and is the only user directory that exists, so the
 * honest state is a prompt to type a name — not a list. A list is what the old
 * client shipped, and it was populated with real primary keys belonging to
 * whoever happened to register first.
 */
export const NO_PEER_LIST_COPY =
  'Search for someone by username. EchoFlow has no contacts or suggestions to ' +
  'offer you, so a share needs the exact name they registered with.';

/**
 * SENT, AND SAYING SO HONESTLY. Rendered once under the result row.
 *
 * The "Sent" badge below it is a LOCAL record — this app cannot read back what it
 * sent (§`ShareDraftState.sentKeys`), and the server will happily record the same
 * share again. A sheet that showed "Sent" and left it there implied a state the
 * client cannot observe; this line is the correction, in the user's terms.
 */
export const RESEND_NOTICE =
  'Sending again would add a second copy to their inbox — nothing on the server stops it.';

/** `find-user` 409. MUST NOT be reachable by the same wording as the 404. */
export const LOOKUP_AMBIGUOUS_COPY =
  'More than one account matches that username, so we cannot tell them apart. ' +
  'Ask for the exact spelling, including capitalisation.';

/** `find-user` 404. */
export const LOOKUP_NOT_FOUND_COPY = 'No listener with that username.';

/** `find-user` 400, no query. Also produced locally by `beginSearch`. */
export const LOOKUP_EMPTY_COPY = 'Enter a username to search.';

/** `find-user` 400, yourself. */
export const LOOKUP_SELF_COPY = 'You cannot share a clip with yourself.';

/** Every other lookup failure, including anything with no status at all. */
export const LOOKUP_GENERIC_COPY =
  'The search could not be completed. Try again in a moment.';

/** No response at all — the connection, not the name, is what failed. */
export const LOOKUP_OFFLINE_COPY =
  'Could not reach the server. Check your connection, then search again.';

/** `send-share` 429 — `share_send` is 100/hour (`settings.py:1013`). */
export const SEND_RATE_LIMITED_COPY =
  'Too many shares. Wait a moment, then try again.';

/** `send-share` with no response. Names the fact that nothing was sent. */
export const SEND_OFFLINE_COPY = 'Could not reach the server. The clip was not sent.';

/** `send-share` 404 — the receiver was erased, or the clip left the servable set. */
export const SEND_GONE_COPY =
  'The server could not find what you asked to share. Search again.';

/** `send-share` 400 whose body carried nothing we can show. */
export const SEND_REJECTED_COPY = 'The server rejected this share. Search again.';

/** Any other failure, including a 5xx that is not the malformed-id case. */
export const SEND_FAILED_COPY = 'The clip could not be sent. Try again in a moment.';

/* ------------------------------------------------------------------ */
/* Keys                                                                 */
/* ------------------------------------------------------------------ */

/**
 * One key per `(clip, recipient)`. The web client's `shareKey` verbatim
 * (`frontend/src/components/sharing/ShareModal.tsx:41`) — see the module
 * docstring for why the clip is in it.
 */
export function shareKey(clipId: string, recipientId: number): string {
  return `${clipId}:${recipientId}`;
}

/** A sheet with nothing in it. The ONLY way one comes into being. */
export function emptyShareDraft(clipId: string): ShareDraftState {
  return {
    clipId,
    recipient: null,
    searchError: null,
    pendingKeys: {},
    sentKeys: {},
    sendError: null,
  };
}

/* ------------------------------------------------------------------ */
/* Search                                                               */
/* ------------------------------------------------------------------ */

/**
 * Trim, and refuse the two shapes that cannot produce a useful search.
 *
 * The bound is `User.username`'s column width (see `FIND_USER_MAX_QUERY`). A
 * longer query is a guaranteed 404 whose body interpolates the whole thing back —
 * so refusing locally is both a round trip saved and a 10 KB error string the
 * sheet never has to render. `findShareUser` throws on the same two conditions
 * as a second line of defence; there is one number, in one place.
 *
 * `.trim()` and not `.toLowerCase()`: the match is `iexact` server-side, so case
 * is not a local decision, and trimming the query here means the length bound is
 * measured on what is actually sent.
 */
export function normaliseUsernameQuery(raw: string): UsernameQuery {
  const query = raw.trim();
  if (query.length === 0) return { kind: 'empty' };
  if (query.length > FIND_USER_MAX_QUERY) {
    return { kind: 'too-long', length: query.length, max: FIND_USER_MAX_QUERY };
  }
  return { kind: 'ready', query };
}

/**
 * The user submitted a search.
 *
 * Either the sheet is now waiting on `find-user` (`'ready'`), or nothing was sent
 * and the reason is on the sheet (`'refused'`).
 *
 * **A refused submit CLEARS the recipient**, and so does a failed search
 * (`failSearch`). The rule: a search result is only ever the answer to the query
 * that is on screen. Leaving a stale row sendable after the user has typed a new
 * name and been told that name is unusable is how a share ends up going to
 * someone the last successful search found, which reads on the wire exactly like a
 * share to the person whose name is in the input.
 *
 * `sendError` is cleared here too: the recipient is gone, so a message about
 * failing to send to them has nothing to attach to.
 */
export function beginSearch(state: ShareDraftState, raw: string): SearchBegin {
  const outcome = normaliseUsernameQuery(raw);
  const cleared: ShareDraftState = {
    ...state,
    recipient: null,
    sendError: null,
  };
  if (outcome.kind === 'empty') {
    return { kind: 'refused', state: { ...cleared, searchError: LOOKUP_EMPTY_COPY }, message: LOOKUP_EMPTY_COPY };
  }
  if (outcome.kind === 'too-long') {
    const message = `Usernames are at most ${outcome.max} characters.`;
    return { kind: 'refused', state: { ...cleared, searchError: message }, message };
  }
  return { kind: 'ready', state: { ...cleared, searchError: null }, query: outcome.query };
}

/**
 * The search found exactly one account.
 *
 * `recipient` is the parsed body, so its `username` is the **stored** spelling —
 * `iexact` matched `ALICE` against `alice` (`views/social.py:169`) and the sheet
 * must show `alice`, not what was typed. Rendering the query back would tell a
 * stranger you have their name at a case you guessed.
 */
export function applySearchResult(
  state: ShareDraftState,
  recipient: ShareRecipient,
): ShareDraftState {
  return { ...state, recipient, searchError: null };
}

/**
 * The search failed. The recipient is cleared — see `beginSearch`.
 *
 * The copy is `lookupFailureCopy`'s, which is where the 409 branch lives.
 */
export function failSearch(state: ShareDraftState, err: unknown): ShareDraftState {
  return { ...state, recipient: null, searchError: lookupFailureCopy(err) };
}

/**
 * `find-user` failures, by cause.
 *
 * The web client mapped 400, 404, 429, 500 and a `TypeError: Failed to fetch` to
 * one sentence, "Peer listener not found in directory.", which is false in four
 * of those five cases and tells the user their username is wrong when the real
 * problem is their connection.
 *
 * **409 gets its own sentence and is checked first**, ahead of the 404, because
 * the two are the same *symptom* with opposite *causes*: in both, the search
 * produced no sendable recipient. In one the name does not exist; in the other it
 * exists twice and the server has refused to guess which
 * (`views/social.py:174-186`). "No listener with that username" sent to two
 * people who both have it is the wrong answer in the more damaging direction — it
 * invites the sender to keep guessing, and a client that "helpfully" fell back to
 * a shorter prefix is the attack the 409 exists to stop.
 */
export function lookupFailureCopy(err: unknown): string {
  if (hasNoResponse(err)) return LOOKUP_OFFLINE_COPY;
  if (isShareAmbiguousUsername(err)) return LOOKUP_AMBIGUOUS_COPY;
  if (isShareSelfRefusal(err)) return LOOKUP_SELF_COPY;

  const status = errorStatus(err) as number;
  if (status === 404) {
    // The server's own sentence names the query it looked for
    // (`No user found: @alice`), which is more useful than our generic one.
    const message = shareErrorMessage(err);
    return message === null || isBoilerplate(message) ? LOOKUP_NOT_FOUND_COPY : message;
  }
  if (status === 400) {
    const message = shareErrorMessage(err);
    return message === null || isBoilerplate(message) ? LOOKUP_GENERIC_COPY : message;
  }
  if (status === 429) {
    return 'Too many searches. Wait a moment, then search again.';
  }
  return LOOKUP_GENERIC_COPY;
}

/* ------------------------------------------------------------------ */
/* Send                                                                 */
/* ------------------------------------------------------------------ */

/**
 * May the send control fire?
 *
 * Exported as a total function for the reason `ActionCluster.canToggleLike` is:
 * an integration test cannot observe a `disabled` control and a guarded handler
 * separately — RNTL will not deliver a `fireEvent` to a control the host has
 * disabled, so it can observe the pair and never either half. Asserting the
 * function makes either half's removal a failure instead of a silent no-op.
 *
 * `isShareable` is consulted BEFORE the in-flight guard because admissibility is
 * not a function of what else is happening: a press on a clip that cannot be
 * shared can never become valid by waiting, and `'refused'` is the more useful
 * answer than `'ignored'`.
 */
export function canSend(
  state: ShareDraftState,
  isShareable: boolean,
): boolean {
  if (!isShareable) return false;
  if (state.recipient === null) return false;
  const key = shareKey(state.clipId, state.recipient.id);
  return state.pendingKeys[key] !== true && state.sentKeys[key] !== true;
}

/**
 * May a press START A NEW REQUEST? — `canSend`.
 *
 * ## WHY THE SENT CONTROL IS *NOT* DISABLED WHILE A SEND IS IN FLIGHT
 * `isSendDisabled` is a DIFFERENT question and the two must not be confused, so
 * they are two functions and the component consults both:
 *
 *  - `canSend` is about the WIRE. True means a press would issue a request.
 *  - `isSendDisabled` is about the CONTROL. True means the press cannot mean
 *    anything at all.
 *
 * They differ in exactly one state, `pending`, and deliberately:
 *
 *  - **terminal states** (no recipient, unshareable, already sent) disable. There
 *    is nothing a press could ever do, and a control that looks live and does
 *    nothing is worse than no control.
 *  - **`pending` does NOT disable.** The request has already been made; the press
 *    that is being ignored is a DUPLICATE, not an invalid one. Keeping the control
 *    enabled keeps it in the accessibility focus set and lets the platform's own
 *    `busy` state carry the news, which is what the web client did and why:
 *    "a natively disabled button leaves the tab order and drops focus to <body>
 *    (WCAG 2.4.3), and the button is focusable again a moment later"
 *    (`ShareModal.tsx:236-239`).
 *
 * The cost of leaving it enabled is a tap that visibly does nothing, which is
 * exactly what the `Sending…` / `busy` presentation is for. The benefit is that
 * the duplicate-press guard is reachable through the real press path instead of
 * only through a direct handler call, which is the difference between a guard that
 * is tested and one that is assumed.
 */
export function isSendDisabled(
  state: ShareDraftState,
  isShareable: boolean,
): boolean {
  if (!isShareable) return true;
  if (state.recipient === null) return true;
  return state.sentKeys[shareKey(state.clipId, state.recipient.id)] === true;
}

/**
 * The user pressed send.
 *
 * ## Check order, and why each one refuses rather than queues
 *
 *  1. **`no-recipient`** — there is no result. **No request is made.** This is the
 *     defect this file exists for.
 *  2. **`not-shareable`** — `isShareable` is false. Also no request: the server
 *     would answer 403 (`views/social.py:239-247`), and a control that can be
 *     pressed to produce a guaranteed error is a bug, not a feature. The refusal
 *     carries copy that does not claim to know why.
 *  3. **`in-flight`** — a request for this `(clip, recipient)` is outstanding.
 *     `services/shares.py:31` is an unconditional `ShareEvent.objects.create`, so
 *     a second press is a second unread inbox row for a stranger plus a second
 *     share-counter bump, and the server will never mention the first.
 *     **`'ignored'`, never `'queued'`** — a queued second send would fire the
 *     instant the first settled, which is exactly the outcome the guard exists to
 *     stop, and the user would watch the button do nothing and then deliver twice.
 *  4. **`already-sent`** — this pair has already succeeded in this sheet session.
 *     Same reasoning as 3, and the reason the `Sent` badge is honest rather than
 *     a progress state.
 *
 * Pure: `state` is never mutated, and the returned state is the only thing the
 * caller should install. On `'ignored'` the returned state IS the input state, so
 * a caller that installs it unconditionally re-renders nothing.
 */
export function startSend(
  state: ShareDraftState,
  isShareable: boolean,
): ShareSendAttempt {
  if (state.recipient === null) {
    return { kind: 'ignored', state, reason: 'no-recipient' };
  }

  if (!isShareable) {
    return {
      kind: 'refused',
      state: { ...state, sendError: SHARE_UNAVAILABLE_COPY },
      message: SHARE_UNAVAILABLE_COPY,
    };
  }

  const key = shareKey(state.clipId, state.recipient.id);
  if (state.pendingKeys[key] === true) {
    return { kind: 'ignored', state, reason: 'in-flight' };
  }
  if (state.sentKeys[key] === true) {
    return { kind: 'ignored', state, reason: 'already-sent' };
  }

  return {
    kind: 'sent',
    key,
    recipient: state.recipient,
    state: { ...state, pendingKeys: { ...state.pendingKeys, [key]: true }, sendError: null },
  };
}

/**
 * Is `key` still the request that is outstanding?
 *
 * The same argument as `followState.isCurrentRequest`, and the reason this is not
 * a boolean. A response that settles after the sheet has moved on — a second
 * search, a different recipient, a close and reopen — must not write into the
 * state that is now on screen. `pendingKeys[key] === true` is the only test that
 * distinguishes "the request I am settling" from "some request": a settled
 * request has already cleared its key, and a boolean `pending` would happily
 * mark the current recipient Sent on the strength of the previous one's success.
 *
 * The clip in the key is the second half of the same protection: after a
 * close-and-reopen the new sheet is a different `clipId`… and after a
 * close-and-reopen of the SAME clip the fresh state has no pending keys at all, so
 * the late settle is a no-op. That is why the sheet re-creates its state on every
 * open instead of resetting it in an effect a tick later.
 */
function isOutstanding(state: ShareDraftState, key: ShareSendKey): boolean {
  return state.pendingKeys[key] === true;
}

function withoutKey(record: Readonly<Record<string, true>>, key: ShareSendKey) {
  if (record[key] !== true) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * The send succeeded. Marks `(clip, recipient)` Sent, locally.
 *
 * There is no server confirmation of this and no way to read it back — the
 * response is `{"status": "shared successfully"}` and nothing else
 * (`views/social.py:250`), and `GET /share/` is the RECIPIENT's inbox
 * (`views/social.py:90`). So the badge is a record of what this client did, which
 * is what `RESEND_NOTICE` tells the user in plain words.
 *
 * **It marks the key even when the user has already moved on to a different
 * recipient**, and that is deliberate in the same direction `failSend` is
 * deliberately narrow: the share really did happen, and forgetting it would let
 * the same person be sent the same clip twice in one sheet session — a second
 * inbox row, which is the outcome this whole file exists to prevent. The record
 * is per `(clip, recipient)`, so it cannot colour any row that is not that one.
 *
 * A stale key is a no-op in BOTH directions: it marks nothing sent and clears no
 * pending key, because a newer request owns that key. See `isOutstanding`.
 */
export function confirmSend(state: ShareDraftState, key: ShareSendKey): ShareDraftState {
  if (!isOutstanding(state, key)) return state;
  return {
    ...state,
    pendingKeys: withoutKey(state.pendingKeys, key),
    sentKeys: { ...state.sentKeys, [key]: true },
    sendError: null,
  };
}

/**
 * The send failed. Clears the in-flight key, and shows the reason only while the
 * row that failed is still on screen.
 *
 * **The asymmetry with `confirmSend` is the point, and it is the same hazard
 * `followState.ts` exists for.** The user can search for someone else while a
 * send is in flight — the in-flight guard is per `(clip, recipient)`, precisely so
 * that a share to one person does not block a share to another. So a failure for
 * the FIRST person can land after the row for the SECOND is on screen, and
 * attaching it there would tell someone that a clip they were about to send was
 * refused, which is a false statement about their action.
 *
 * So: clear the key always (the request settled; leaving it would wedge the
 * button for that recipient), and set `sendError` only when the key IS the
 * current recipient's. The failure is not lost — `pendingKeys` is per key, and a
 * later send to the same person is a fresh press that reports its own outcome.
 *
 * A key that is not outstanding at all is a full no-op: the response it belongs to
 * has already been accounted for.
 */
export function failSend(
  state: ShareDraftState,
  key: ShareSendKey,
  err: unknown,
): ShareDraftState {
  if (!isOutstanding(state, key)) return state;
  const onScreen =
    state.recipient !== null && shareKey(state.clipId, state.recipient.id) === key;
  return {
    ...state,
    pendingKeys: withoutKey(state.pendingKeys, key),
    sendError: onScreen ? sendFailureCopy(err) : state.sendError,
  };
}

/**
 * `send-share` failures, by cause. **A failed send must never read as "Sent".**
 *
 * The web client's catch was `console.warn` only, so a refused share was
 * indistinguishable from a delivered one — which, on a licence refusal, means the
 * user believes a third party has audio they were never sent.
 */
export function sendFailureCopy(err: unknown): string {
  if (hasNoResponse(err)) return SEND_OFFLINE_COPY;
  // Before the 404: both mean "the server would not do it", and the licence
  // sentence is the one the user can act on.
  if (isShareLicenceRefused(err)) {
    // The server's own sentence names no right and no licence flag, and neither
    // does ours — see `SHARE_UNAVAILABLE_COPY`.
    const message = shareErrorMessage(err);
    return message === null || isBoilerplate(message) ? SHARE_UNAVAILABLE_COPY : message;
  }
  if (isShareReceiverIdUnusable(err)) return SHARE_UNAVAILABLE_COPY;

  const status = errorStatus(err) as number;
  if (status === 404) return SEND_GONE_COPY;
  if (status === 400) {
    // The server's 400 sentences are a fixed pair — "Receiver ID required" and
    // "You can't share with yourself" (`views/social.py:221, 227`) — so passing
    // one through is safe, and a reader is better served by it than by anything
    // generic. This is the ONLY status where the raw body reaches the UI beside
    // 403, and both have a closed vocabulary; that restriction is deliberate and
    // it is why there is no "is this string a success message?" filter.
    const message = shareErrorMessage(err);
    return message === null || isBoilerplate(message) ? SEND_REJECTED_COPY : message;
  }
  if (status === 429) return SEND_RATE_LIMITED_COPY;
  return SEND_FAILED_COPY;
}
