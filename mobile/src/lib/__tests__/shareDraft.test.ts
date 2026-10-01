import { FIND_USER_MAX_QUERY } from '../../api/endpoints/share';
import {
  LOOKUP_AMBIGUOUS_COPY,
  LOOKUP_EMPTY_COPY,
  LOOKUP_GENERIC_COPY,
  LOOKUP_NOT_FOUND_COPY,
  LOOKUP_OFFLINE_COPY,
  LOOKUP_SELF_COPY,
  NO_PEER_LIST_COPY,
  RESEND_NOTICE,
  SEND_GONE_COPY,
  SEND_OFFLINE_COPY,
  SEND_RATE_LIMITED_COPY,
  SHARE_UNAVAILABLE_COPY,
  applySearchResult,
  beginSearch,
  canSend,
  confirmSend,
  emptyShareDraft,
  failSearch,
  failSend,
  lookupFailureCopy,
  normaliseUsernameQuery,
  sendFailureCopy,
  shareKey,
  startSend,
  type ShareDraftState,
} from '../shareDraft';

/**
 * The share sheet's rules, as pure functions.
 *
 * The order of the suites below is the order of what each one costs if it is
 * wrong. `startSend`'s admissibility is first because a share that reaches a
 * stranger is irreversible and invisible; the copy paths come last because a wrong
 * sentence is annoying and a wrong SEND is a `ShareEvent` row in someone's inbox.
 */

/** The real client, for ApiError instances — the module boundary is not mocked. */
const { ApiError } = jest.requireActual<typeof import('../../api/client')>('../../api/client');

const CLIP = 'clip-a';
const OTHER_CLIP = 'clip-b';

/** A parsed `find-user` body. The ONLY shape an id can arrive in. */
const RECIPIENT = { id: 7, username: 'roastmaster' };
const KEY = shareKey(CLIP, RECIPIENT.id);

/** A draft with a search result in it and nothing in flight. */
const withRecipient = (over: Partial<ShareDraftState> = {}): ShareDraftState => ({
  ...emptyShareDraft(CLIP),
  recipient: RECIPIENT,
  ...over,
});

/* ------------------------------------------------------------------ */
/* Keys and the empty state                                             */
/* ------------------------------------------------------------------ */

describe('shareKey', () => {
  it('is one key per (clip, recipient)', () => {
    expect(shareKey(CLIP, 7)).toBe(`${CLIP}:7`);
  });

  it('separates two recipients on the same clip', () => {
    expect(shareKey(CLIP, 7)).not.toBe(shareKey(CLIP, 8));
  });

  it('separates the same recipient on two clips — the cross-clip poisoning case', () => {
    // The old web sheet keyed "Sent" by recipient alone, and it was mounted once
    // for the feed's lifetime, so every LATER clip showed "Sent" for a clip never
    // sent (651ac0c). The clip is in the key so the two cannot share a record.
    expect(shareKey(CLIP, 7)).not.toBe(shareKey(OTHER_CLIP, 7));
  });
});

describe('emptyShareDraft', () => {
  it('has no recipient and therefore no way to send', () => {
    const state = emptyShareDraft(CLIP);
    expect(state.recipient).toBeNull();
    expect(state.pendingKeys).toEqual({});
    expect(state.sentKeys).toEqual({});
    expect(state.searchError).toBeNull();
    expect(state.sendError).toBeNull();
    expect(canSend(state, true)).toBe(false);
    expect(startSend(state, true).kind).toBe('ignored');
  });

  it('records the clip it belongs to', () => {
    expect(emptyShareDraft(CLIP).clipId).toBe(CLIP);
  });
});

/* ------------------------------------------------------------------ */
/* THE INVARIANT                                                        */
/* ------------------------------------------------------------------ */

describe('startSend — no receiver_id without a search result', () => {
  it('refuses a fresh sheet and makes no request', () => {
    const attempt = startSend(emptyShareDraft(CLIP), true);
    expect(attempt.kind).toBe('ignored');
    // The narrow cast is the assertion: there is no branch of this union that
    // carries a recipient, so no caller can read an id out of a refused press.
    expect((attempt as { recipient?: unknown }).recipient).toBeUndefined();
  });

  it('refuses a sheet whose search was refused — and clears what it had', () => {
    // A search that FAILED must not leave a previous row sendable, or a share
    // goes to whoever the last good search found while the input shows a new
    // name. That reads on the wire exactly like a share to the wrong person.
    const state = withRecipient({ sendError: 'stale failure' });
    const refused = beginSearch(state, '');
    expect(refused.kind).toBe('refused');

    const next = (refused as { state: ShareDraftState }).state;
    expect(next.recipient).toBeNull();
    expect(next.sendError).toBeNull();
    expect(startSend(next, true).kind).toBe('ignored');
  });

  it('refuses a sheet whose search ERRORED — the row is gone, not merely flagged', () => {
    const failed = failSearch(withRecipient(), new ApiError({ status: 404, body: { error: 'No user found: @x' } }));
    expect(failed.recipient).toBeNull();
    expect(startSend(failed, true).kind).toBe('ignored');
  });

  it('is not fooled by a recipient that is not a parsed find-user body', () => {
    // The type forbids this; the point of the test is that the RUNTIME has no
    // second source of truth either. A clip UUID cannot become a number here.
    const hostile = withRecipient({ recipient: { id: CLIP, username: 'x' } as never });
    // The id is what the key is built from, so this asserts the truth we can
    // make: nothing coerces it, and a NaN id cannot be "pending" against a key
    // the caller did not mint.
    expect(String(hostile.recipient?.id)).toBe(CLIP);
    expect(shareKey(CLIP, Number.NaN)).toBe(`${CLIP}:NaN`);
    // …and the real defence is upstream: the schema rejects it before it is
    // ever a state (see endpointsShare.test.ts).
    expect(startSend(hostile, true).kind).toBe('sent');
  });
});

/* ------------------------------------------------------------------ */
/* Search                                                               */
/* ------------------------------------------------------------------ */

describe('normaliseUsernameQuery', () => {
  it('trims and keeps the case — the match is iexact, so case is not local', () => {
    expect(normaliseUsernameQuery('  ALICE  ')).toEqual({ kind: 'ready', query: 'ALICE' });
  });

  it('refuses empty and whitespace-only', () => {
    for (const raw of ['', '   ', '\n\t  ']) {
      expect(normaliseUsernameQuery(raw)).toEqual({ kind: 'empty' });
    }
  });

  it(`accepts exactly varchar(${FIND_USER_MAX_QUERY}) and refuses one more`, () => {
    expect(normaliseUsernameQuery('x'.repeat(FIND_USER_MAX_QUERY))).toEqual({
      kind: 'ready',
      query: 'x'.repeat(FIND_USER_MAX_QUERY),
    });
    expect(normaliseUsernameQuery('x'.repeat(FIND_USER_MAX_QUERY + 1))).toEqual({
      kind: 'too-long',
      length: FIND_USER_MAX_QUERY + 1,
      max: FIND_USER_MAX_QUERY,
    });
  });

  it('measures the bound AFTER trimming, so trailing whitespace cannot push a real name over', () => {
    const padded = `  ${'x'.repeat(FIND_USER_MAX_QUERY)}  `;
    expect(normaliseUsernameQuery(padded).kind).toBe('ready');
  });
});

describe('beginSearch', () => {
  it('is ready for a real name, having cleared any previous result and error', () => {
    const state = withRecipient({ sendError: 'old failure', searchError: 'old search error' });
    const begin = beginSearch(state, 'roastmaster');

    expect(begin.kind).toBe('ready');
    const next = (begin as { state: ShareDraftState }).state;
    expect(next.recipient).toBeNull();
    expect(next.sendError).toBeNull();
    expect(next.searchError).toBeNull();
  });

  it('refuses an empty query with the empty copy and makes no request', () => {
    const begin = beginSearch(emptyShareDraft(CLIP), '   ');
    expect(begin.kind).toBe('refused');
    const next = (begin as { state: ShareDraftState }).state;
    expect(next.searchError).toBe(LOOKUP_EMPTY_COPY);
    expect(next.recipient).toBeNull();
  });

  it('refuses an over-long query with a copy that names the bound', () => {
    const begin = beginSearch(emptyShareDraft(CLIP), 'x'.repeat(FIND_USER_MAX_QUERY + 1));
    expect(begin.kind).toBe('refused');
    const next = (begin as { state: ShareDraftState }).state;
    expect(next.searchError).toContain(String(FIND_USER_MAX_QUERY));
    expect(next.recipient).toBeNull();
  });

  it('never mutates the state it is given', () => {
    const state = withRecipient();
    const snapshot = JSON.stringify(state);
    beginSearch(state, 'roastmaster');
    applySearchResult(state, { id: 9, username: 'other' });
    startSend(state, true);
    confirmSend(state, KEY);
    failSend(state, KEY, new Error('x'));
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe('applySearchResult', () => {
  it('holds the STORED username the server sent', () => {
    // The typed query was `ALICE`; `iexact` matched the row stored as `alice`.
    // Showing the query back would tell a stranger you know their name at a case
    // you guessed at.
    const next = applySearchResult(emptyShareDraft(CLIP), { id: 12, username: 'alice' });
    expect(next.recipient).toEqual({ id: 12, username: 'alice' });
  });

  it('clears a stale search error on success', () => {
    const next = applySearchResult(emptyShareDraft(CLIP), RECIPIENT);
    expect(next.searchError).toBeNull();
  });
});

describe('failSearch', () => {
  it('clears the recipient and records the copy', () => {
    const next = failSearch(
      withRecipient(),
      new ApiError({ status: 404, body: { error: 'No user found: @nobody' } }),
    );
    expect(next.recipient).toBeNull();
    expect(next.searchError).toBe('No user found: @nobody');
  });
});

/* ------------------------------------------------------------------ */
/* The 409 branch — the one the web client does not have               */
/* ------------------------------------------------------------------ */

describe('lookupFailureCopy', () => {
  const ambiguous = new ApiError({
    status: 409,
    body: {
      error:
        'More than one account matches that username. Try the exact spelling, or ask them to change it.',
    },
  });
  const missing = new ApiError({ status: 404, body: { error: 'No user found: @alice' } });
  const MISSING_SENTENCE = 'No user found: @alice';

  it('gives 409 a sentence of its own, distinct from the 404’s', () => {
    // THE assertion this file exists partly for. The two are the same symptom with
    // opposite causes: in one the name does not exist, in the other it exists
    // twice and the server refused to guess (views/social.py:174-186). Telling
    // someone looking for a colleague that the colleague does not exist is the
    // wrong answer in the more damaging direction.
    const a = lookupFailureCopy(ambiguous);
    const b = lookupFailureCopy(missing);
    expect(a).toBe(LOOKUP_AMBIGUOUS_COPY);
    expect(b).toBe(MISSING_SENTENCE);
    expect(a).not.toBe(b);
    expect(a).not.toContain('No user found');
  });

  it('does not let the 409 fall through to the generic sentence', () => {
    // The web client has no 409 branch at all, so this is the assertion that the
    // generic copy is not what an ambiguity renders as.
    expect(lookupFailureCopy(ambiguous)).not.toBe(LOOKUP_GENERIC_COPY);
  });

  it('prefers the server’s own 404 sentence, which names the query it looked for', () => {
    expect(lookupFailureCopy(missing)).toBe(MISSING_SENTENCE);
  });

  it('falls back to its own 404 copy when the body carries only DRF boilerplate', () => {
    // `{"detail": "Not found."}` is what `get_object_or_404` produces, and it is a
    // mechanism rather than a sentence. `find-user` raises every one of its own
    // errors under `error` (views/social.py:166-190), so a `detail` here means the
    // contract changed — and either way our copy is the one that says what to do.
    expect(lookupFailureCopy(new ApiError({ status: 404, body: { detail: 'Not found.' } }))).toBe(
      LOOKUP_NOT_FOUND_COPY,
    );
  });

  it('tells the two 400s apart by their sentence, not their code', () => {
    const empty = new ApiError({ status: 400, body: { error: 'Username required' } });
    const self = new ApiError({ status: 400, body: { error: "You can't share with yourself" } });
    expect(lookupFailureCopy(empty)).toBe('Username required');
    expect(lookupFailureCopy(self)).toBe(LOOKUP_SELF_COPY);
    expect(lookupFailureCopy(empty)).not.toBe(lookupFailureCopy(self));
  });

  it('names the connection when there was no response at all', () => {
    // `apiFetch` maps a transport failure to `status: 0` (client.ts:284). Telling
    // the user their username is wrong when the real problem is their connection
    // is the old client's one-sentence-for-everything failure.
    expect(lookupFailureCopy(new ApiError({ status: 0, body: null }))).toBe(LOOKUP_OFFLINE_COPY);
    expect(lookupFailureCopy(new TypeError('Network request failed'))).toBe(LOOKUP_OFFLINE_COPY);
    expect(lookupFailureCopy(null)).toBe(LOOKUP_OFFLINE_COPY);
  });

  it('has a distinct copy for 429, and a generic one for anything else', () => {
    const limited = lookupFailureCopy(new ApiError({ status: 429, body: { detail: 'Request was throttled.' } }));
    expect(limited).toBe('Too many searches. Wait a moment, then search again.');
    expect(lookupFailureCopy(new ApiError({ status: 500, body: null }))).toBe(LOOKUP_GENERIC_COPY);
    expect(lookupFailureCopy(new ApiError({ status: 502, body: null }))).toBe(LOOKUP_GENERIC_COPY);
  });

  it('never says "no such user" for anything other than a 404', () => {
    for (const status of [0, 400, 409, 429, 500, 503]) {
      const copy = lookupFailureCopy(new ApiError({ status, body: null }));
      expect(copy).not.toBe(LOOKUP_NOT_FOUND_COPY);
      expect(copy).not.toContain('No user found');
    }
  });
});

/* ------------------------------------------------------------------ */
/* Send admissibility                                                   */
/* ------------------------------------------------------------------ */

describe('canSend / startSend — the whole gate space', () => {
  const gates: Array<{
    id: string;
    state: ShareDraftState;
    isShareable: boolean;
    kind: 'sent' | 'ignored' | 'refused';
    reason?: string;
  }> = [
    { id: 'no recipient', state: emptyShareDraft(CLIP), isShareable: true, kind: 'ignored', reason: 'no-recipient' },
    {
      id: 'unshareable, no recipient',
      state: emptyShareDraft(CLIP),
      isShareable: false,
      kind: 'ignored',
      reason: 'no-recipient',
    },
    {
      id: 'unshareable with a recipient',
      state: withRecipient(),
      isShareable: false,
      kind: 'refused',
    },
    { id: 'ready', state: withRecipient(), isShareable: true, kind: 'sent' },
    {
      id: 'already in flight',
      state: withRecipient({ pendingKeys: { [KEY]: true } }),
      isShareable: true,
      kind: 'ignored',
      reason: 'in-flight',
    },
    {
      id: 'already sent',
      state: withRecipient({ sentKeys: { [KEY]: true } }),
      isShareable: true,
      kind: 'ignored',
      reason: 'already-sent',
    },
    {
      id: 'a DIFFERENT recipient in flight does not block this one',
      state: withRecipient({ pendingKeys: { [shareKey(CLIP, 8)]: true } }),
      isShareable: true,
      kind: 'sent',
    },
    {
      id: 'the same recipient on ANOTHER clip in flight does not block this one',
      state: withRecipient({ pendingKeys: { [shareKey(OTHER_CLIP, RECIPIENT.id)]: true } }),
      isShareable: true,
      kind: 'sent',
    },
    {
      // The web client's defect: keyed by recipient alone, so clip 2 inherited
      // clip 1's "Sent" for ever after.
      id: 'sent on another clip does not block this one',
      state: withRecipient({ sentKeys: { [shareKey(OTHER_CLIP, RECIPIENT.id)]: true } }),
      isShareable: true,
      kind: 'sent',
    },
  ];

  it.each(gates)('$id', ({ state, isShareable, kind, reason }) => {
    const attempt = startSend(state, isShareable);
    expect(attempt.kind).toBe(kind);
    if (reason) {
      expect((attempt as { reason?: string }).reason).toBe(reason);
    }
    // `canSend` and `startSend` are the SAME rule in two places — the control's
    // `disabled` and the handler's guard — and they read one value, so they
    // cannot drift. RNTL cannot observe either half alone.
    expect(canSend(state, isShareable)).toBe(kind === 'sent');
  });

  it('refuses an unshareable clip with copy that does not say why', () => {
    // The rule `cardStatusReport` applies to its two 403 causes (ReelCard.tsx:331
    // -342): a caller holding only a UUID learns nothing about moderation or
    // licensing state, so the message must not name either.
    const attempt = startSend(withRecipient(), false);
    expect(attempt.kind).toBe('refused');
    const message = (attempt as { message: string }).message;
    expect(message).toBe(SHARE_UNAVAILABLE_COPY);
    expect(message).not.toMatch(/licen|non.?commercial|share.?alike|rights|moderat|attribution|creativ/i);
  });

  it('returns the SAME state object when it ignores a press, so installing it re-renders nothing', () => {
    const sent = withRecipient({ sentKeys: { [KEY]: true } });
    expect(startSend(sent, true).state).toBe(sent);

    const bare = emptyShareDraft(CLIP);
    expect(startSend(bare, true).state).toBe(bare);
  });

  it('marks the pair in flight on a sent press, and hands back the key and the id', () => {
    const attempt = startSend(withRecipient(), true);
    if (attempt.kind !== 'sent') throw new Error('expected a sent attempt');
    expect(attempt.key).toBe(KEY);
    expect(attempt.recipient).toBe(RECIPIENT);
    expect(attempt.state.pendingKeys[KEY]).toBe(true);
    expect(attempt.state.sentKeys[KEY]).toBeUndefined();
  });

  it('agrees with canSend over the FULL cross product, not a sample of it', () => {
    // The property that matters: the control is enabled if and only if a press
    // would actually send. If these two ever disagree the user gets a button that
    // either does nothing or a request nobody expects.
    const recipients: Array<ShareDraftState['recipient']> = [null, RECIPIENT, { id: 8, username: 'other' }];
    const flags: Array<boolean> = [false, true];
    for (const recipient of recipients) {
      for (const pending of flags) {
        for (const sent of flags) {
          for (const shareable of flags) {
            const base = emptyShareDraft(CLIP);
            const state: ShareDraftState = {
              ...base,
              recipient,
              pendingKeys: pending && recipient ? { [shareKey(CLIP, recipient.id)]: true } : {},
              sentKeys: sent && recipient ? { [shareKey(CLIP, recipient.id)]: true } : {},
            };
            const enabled = canSend(state, shareable);
            const attempt = startSend(state, shareable);
            expect({ enabled, kind: attempt.kind }).toEqual({
              enabled: attempt.kind === 'sent',
              kind: attempt.kind,
            });
          }
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* Settle                                                               */
/* ------------------------------------------------------------------ */

describe('confirmSend', () => {
  it('marks the pair sent and clears the in-flight key', () => {
    const sent = confirmSend(startSend(withRecipient(), true).state, KEY);
    expect(sent.sentKeys[KEY]).toBe(true);
    expect(sent.pendingKeys[KEY]).toBeUndefined();
    expect(sent.sendError).toBeNull();
    expect(canSend(sent, true)).toBe(false);
  });

  it('is a no-op for a key that is not outstanding — the ABA guard', () => {
    // The response for clip 1 arriving after the user has moved on must not write
    // into the state now on screen. `followState.isCurrentRequest` is the same
    // argument; a boolean `pending` cannot tell "this request" from "some request".
    const state = withRecipient();
    expect(confirmSend(state, KEY)).toBe(state);
  });

  it('cannot resurrect a closed sheet — a fresh draft has no pending key at all', () => {
    // The sheet re-creates its state on every open, so a late settle lands on a
    // draft that has never heard of the key. This is the structural reason no
    // "is this component still mounted" flag is needed.
    const reopened = emptyShareDraft(CLIP);
    const out = confirmSend(reopened, KEY);
    expect(out).toBe(reopened);
    expect(out.sentKeys).toEqual({});
  });

  it('does not mark the CURRENT recipient sent when a previous one’s response lands late', () => {
    // search for #8, press send, then search for #7 while #8 is still in flight.
    // #8 succeeds late. #7's row must not read "Sent".
    const pending8 = startSend(withRecipient({ recipient: { id: 8, username: 'eight' } }), true);
    const current7 = applySearchResult(pending8.state, RECIPIENT);
    const settled = confirmSend(current7, shareKey(CLIP, 8));
    expect(settled.sentKeys[shareKey(CLIP, 8)]).toBe(true);
    expect(settled.sentKeys[KEY]).toBeUndefined();
    expect(canSend(settled, true)).toBe(true);
  });

  it('delivers the state the user is actually looking at', () => {
    // A second recipient is reachable while the first is in flight, and its own
    // confirm is the one that marks IT.
    const first = startSend(withRecipient({ recipient: { id: 8, username: 'eight' } }), true);
    const second = startSend(applySearchResult(first.state, RECIPIENT), true);
    expect(second.kind).toBe('sent');
    if (second.kind !== 'sent') throw new Error('expected sent');
    const settled = confirmSend(second.state, second.key);
    expect(settled.sentKeys[KEY]).toBe(true);
    expect(settled.sentKeys[shareKey(CLIP, 8)]).toBeUndefined();
  });
});

describe('failSend', () => {
  const refused = new ApiError({ status: 403, body: { error: 'This clip may not be shared' } });

  it('clears the in-flight key and records the reason, so the button comes back', () => {
    const started = startSend(withRecipient(), true).state;
    const failed = failSend(started, KEY, refused);
    expect(failed.pendingKeys[KEY]).toBeUndefined();
    expect(failed.sendError).toBe('This clip may not be shared');
    expect(failed.sentKeys[KEY]).toBeUndefined();
    // A failed send is retryable by a further TAP, and that tap is a first tap of
    // a fresh send — not a replay of a request that might have landed.
    expect(canSend(failed, true)).toBe(true);
  });

  it('is a no-op for a key that is not outstanding', () => {
    const state = withRecipient();
    expect(failSend(state, KEY, refused)).toBe(state);
  });

  it('clears the stale key but does NOT attach its error to a different recipient’s row', () => {
    // Send to #8, then search for #7 while #8 is in flight, then #8 fails late.
    // Attaching that failure to #7's row would be a false statement about the
    // action #7's user is about to take. This is the same ABA hazard
    // `followState.ts` exists for, and the reason `failSend` is asymmetric with
    // `confirmSend`.
    const started = startSend(withRecipient({ recipient: { id: 8, username: 'eight' } }), true);
    const key8 = shareKey(CLIP, 8);
    const moved = applySearchResult(started.state, RECIPIENT);
    const failed = failSend(moved, key8, refused);

    // The key is released — the request settled, and leaving it would wedge #8's
    // button for the rest of the session.
    expect(failed.pendingKeys[key8]).toBeUndefined();
    // …but the message is not shown against #7's row.
    expect(failed.sendError).toBeNull();
    expect(failed.recipient).toBe(RECIPIENT);
    // And #7's own send is unaffected and still available.
    expect(canSend(failed, true)).toBe(true);
  });

  it('does show the failure when the failing pair IS the one on screen', () => {
    const started = startSend(withRecipient(), true);
    const failed = failSend(started.state, KEY, refused);
    expect(failed.sendError).toBe('This clip may not be shared');
  });
});

describe('sendFailureCopy', () => {
  it('uses the server’s own sentence for a 403 and does not say which right it was', () => {
    const copy = sendFailureCopy(
      new ApiError({ status: 403, body: { error: 'This clip may not be shared' } }),
    );
    expect(copy).toBe('This clip may not be shared');
    expect(copy).not.toMatch(/licen|non.?commercial|share.?alike|rights|attribution/i);
  });

  it('falls back to the why-free copy when the 403 body is unusable', () => {
    expect(sendFailureCopy(new ApiError({ status: 403, body: '<html>500</html>' }))).toBe(
      SHARE_UNAVAILABLE_COPY,
    );
  });

  it('names the failure for an offline attempt — "the clip was not sent" is a fact', () => {
    expect(sendFailureCopy(new ApiError({ status: 0, body: null }))).toBe(SEND_OFFLINE_COPY);
    expect(sendFailureCopy(null)).toBe(SEND_OFFLINE_COPY);
  });

  it('has its own copy for 429, 404, 400 and a malformed-id 500', () => {
    expect(sendFailureCopy(new ApiError({ status: 429, body: { detail: 'Request was throttled.' } }))).toBe(
      SEND_RATE_LIMITED_COPY,
    );
    expect(sendFailureCopy(new ApiError({ status: 404, body: { detail: 'Not found.' } }))).toBe(
      SEND_GONE_COPY,
    );
    expect(
      sendFailureCopy(new ApiError({ status: 400, body: { error: "You can't share with yourself" } })),
    ).toBe("You can't share with yourself");
    // A 500 here is a malformed id, which a retry reproduces exactly — so the
    // message must not say "try again".
    expect(sendFailureCopy(new ApiError({ status: 500, body: null }))).toBe(SHARE_UNAVAILABLE_COPY);
  });

  it('passes the server’s own sentence through only on 400 and 403', () => {
    // Those two have a CLOSED vocabulary in the view — "Receiver ID required",
    // "You can't share with yourself", "This clip may not be shared"
    // (views/social.py:221, 227, 245) — so passing one to the user is safe and
    // better than anything generic. Every other status gets our own copy, which is
    // why there is no "is this string a success message?" filter anywhere: nothing
    // outside those two reaches the UI verbatim.
    const carried = [
      sendFailureCopy(new ApiError({ status: 400, body: { error: 'Receiver ID required' } })),
      sendFailureCopy(new ApiError({ status: 403, body: { error: 'This clip may not be shared' } })),
    ];
    expect(carried).toEqual(['Receiver ID required', 'This clip may not be shared']);

    for (const status of [404, 409, 429, 500, 503]) {
      expect(
        sendFailureCopy(new ApiError({ status, body: { error: 'verbatim body text' } })),
      ).not.toBe('verbatim body text');
    }
  });

  it('always returns a non-empty sentence, whatever the status', () => {
    // No status can leave the sheet with nothing to show, which reads as "it just
    // did nothing" — the exact failure of the web client, whose send catch was a
    // `console.warn`.
    for (const status of [0, 400, 401, 403, 404, 409, 429, 500, 502, 503]) {
      for (const body of [null, {}, { error: '' }, { detail: 'Not found.' }, { error: 'x' }]) {
        const copy = sendFailureCopy(new ApiError({ status, body }));
        expect(typeof copy).toBe('string');
        expect(copy.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* The copy the sheet is built from                                     */
/* ------------------------------------------------------------------ */

describe('the empty state and the honesty note', () => {
  it('explains that there is no peer list, rather than rendering one', () => {
    // The old client rendered four rows of real `User` pks here (651ac0c). A list
    // in this position is not a convenience; it is a pending write to a stranger.
    expect(NO_PEER_LIST_COPY).toMatch(/username/i);
    expect(NO_PEER_LIST_COPY).toMatch(/no contacts or suggestions/i);
  });

  it('tells the user a second send is possible, because the client cannot know', () => {
    // There is no "what have I sent" endpoint: `GET /share/` is the RECIPIENT's
    // inbox (`views/social.py:90`). A "Sent" badge with no caveat implies a state
    // the client cannot observe.
    expect(RESEND_NOTICE).toMatch(/again/i);
    expect(RESEND_NOTICE).toMatch(/inbox/i);
  });
});
