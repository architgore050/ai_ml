import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import type { TestInstance } from 'test-renderer';

import { ShareModal, type ShareModalProps } from '../ShareModal';
import { FIND_USER_MAX_QUERY, findShareUser, sendShare } from '../../../api/endpoints/share';
import {
  LOOKUP_AMBIGUOUS_COPY,
  RESEND_NOTICE,
  SHARE_UNAVAILABLE_COPY,
} from '../../../lib/shareDraft';
import { zIndex } from '../../../design/tokens';

/**
 * The share sheet.
 *
 * ## WHAT IS MOCKED, AND WHY IT IS ONLY THE MODULE BOUNDARY
 * `../../../api/endpoints/share` is mocked, with `requireActual` spread in, so the
 * ERROR PREDICATES stay real: `lib/shareDraft` imports `isShareAmbiguousUsername`,
 * `isShareLicenceRefused` and friends to decide copy, and a hand-rolled mock of
 * that module would leave those as `undefined` and every failure test would fail
 * for the wrong reason. The component under test is the shipped one — press →
 * guard → request → settle — and assertions land on the two mocked functions and
 * on the rendered tree, never on a component internal.
 *
 * ## THE IN-FLIGHT GUARD HAS TWO ENFORCEMENT POINTS AND RNTL CAN ONLY REACH ONE
 * RNTL gates a press on the host's own `onStartShouldSetResponder()`, which
 * `Pressability` derives from `disabled` — so once the send button is disabled
 * because a request is in flight, a `fireEvent` at it is swallowed by the HARNESS.
 * An integration test can therefore observe the PAIR and never either half:
 * remove only the button's `disabled` and the handler guard still holds (green);
 * remove only the handler guard and the responder still holds (green).
 *
 * That is why `canSend` is an exported total function in `lib/shareDraft.ts` (the
 * `canToggleLike` / `canOpenShare` discipline) and why the double-tap test presses
 * the SECOND time through `props.onPress()` — the only route to the handler guard
 * once the responder has taken the control away. Both halves are asserted, in
 * different places, so removing either one is a failure rather than a silent
 * no-op.
 *
 * ## THE SENT-BUTTON `disabled` IS NOT WHAT STOPS THE SECOND PRESS
 * Stated because it is the whole reason the test above reaches past the harness: a
 * green double-tap test that went through `fireEvent` twice would pass with the
 * handler guard deleted, and would then be the exact test the old web client did
 * not have.
 *
 * ## THE MID-FLIGHT WINDOW IS ASSERTED ON THE OUTCOME, NOT THE ORDER
 * Same measurement as `ActionCluster.test.tsx`: `await fireEvent.press` does not
 * return while a handler awaits an unsettled promise, and fake timers do not own
 * React's task queue. So the pending state is asserted by (a) the control being
 * disabled, (b) the second press producing no second request, and (c) the settled
 * row reading "Sent". The ORDER — write before response — is not observable here
 * and is not claimed.
 *
 * ## `Modal` IS REAL, NOT MOCKED
 * RN's `Modal` renders its children into the tree under this jest-expo preset, so
 * the sheet is asserted through the platform component it actually ships in. A
 * per-suite `jest.mock('react-native')` that stubbed `Modal` to a `View` would
 * have removed the `accessibilityViewIsModal` / `onRequestClose` surface this
 * sheet's accessibility contract rests on.
 */

jest.mock('../../../api/endpoints/share', () => ({
  ...jest.requireActual<typeof import('../../../api/endpoints/share')>(
    '../../../api/endpoints/share',
  ),
  findShareUser: jest.fn(),
  sendShare: jest.fn(),
}));

const mockFindShareUser = findShareUser as jest.MockedFunction<typeof findShareUser>;
const mockSendShare = sendShare as jest.MockedFunction<typeof sendShare>;

/** The real client, for the ApiError instances the endpoint would have thrown. */
const { ApiError } = jest.requireActual<typeof import('../../../api/client')>(
  '../../../api/client',
);

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const CLIP = '11111111-1111-1111-1111-111111111111';
const OTHER_CLIP = '22222222-2222-2222-2222-222222222222';

/** A parsed `find-user` body — the ONLY shape an id can arrive in. */
const RECIPIENT = { id: 7, username: 'roastmaster' };

const SEND_OK = { status: 'shared successfully' } as const;

type Rendered = Awaited<ReturnType<typeof render>>;

const ROOT = 'share-sheet-backdrop';
const SCRIM = 'share-sheet-scrim';
const CLOSE = 'share-sheet-close';
const INPUT = 'share-search-input';
const SUBMIT = 'share-search-submit';
const SEARCH_ERROR = 'share-search-error';
const RESULT = 'share-result';
const USERNAME = 'share-result-username';
const SEND = 'share-send';
const SEND_ERROR = 'share-send-error';
const EMPTY = 'share-empty-state';
const UNAVAILABLE = 'share-unavailable';

const baseProps = (over: Partial<ShareModalProps> = {}): ShareModalProps => ({
  clipId: CLIP,
  title: 'Rain on a Tin Roof',
  creatorName: 'somebody',
  isShareable: true,
  visible: true,
  onClose: jest.fn(),
  ...over,
});

const renderSheet = (over: Partial<ShareModalProps> = {}) =>
  render(<ShareModal {...baseProps(over)} />);

const q = (r: Rendered, testID: string): TestInstance | null =>
  r.queryByTestId(testID);

/**
 * Every string rendered AT or under a node, in render order.
 *
 * NOT `queryAll((n) => typeof n.props.children === 'string')`: `queryAll` excludes
 * the instance it is called on (`includeSelf: false`,
 * `test-renderer/dist/index.js:40`), and for a `<Text>{copy}</Text>` that copy IS
 * the node's own `children` prop — so the obvious implementation returns nothing
 * for exactly the nodes whose text a test cares most about. Reading `props.children`
 * first and only then descending covers both spellings without double counting.
 */
function stringsUnder(node: TestInstance): string[] {
  const own = node.props?.children;
  if (typeof own === 'string') return own.trim() ? [own] : [];
  return node.children.flatMap((child) =>
    typeof child === 'string' ? (child.trim() ? [child] : []) : stringsUnder(child),
  );
}

/** A subtree's copy as one string — what a reader would meet. */
const allText = (node: TestInstance): string => stringsUnder(node).join(' | ');

/** The label of the send control in its current state. */
const sendLabel = (r: Rendered): unknown => {
  const send = r.getByTestId(SEND);
  return send.props.accessibilityLabel;
};

/** A static style. Nothing here animates, so `props.style` is not frozen. */
function styleOf(node: TestInstance): Record<string, unknown> {
  const raw = node.props.style;
  const resolved =
    typeof raw === 'function'
      ? (raw as (state: { pressed: boolean }) => unknown)({ pressed: false })
      : raw;
  return (StyleSheet.flatten(resolved as never) ?? {}) as Record<string, unknown>;
}

/** Type into the search field the way a user does. */
async function type(r: Rendered, text: string) {
  await fireEvent.changeText(r.getByTestId(INPUT), text);
}

/** Press the search control and let `find-user` settle. */
async function search(r: Rendered, name = 'roastmaster') {
  await type(r, name);
  await fireEvent.press(r.getByTestId(SUBMIT));
  await settle();
}

/** Flush a settled mock and the state updates around it. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** A promise plus its resolvers, so a request can be left in flight on purpose. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mockFindShareUser.mockReset();
  mockSendShare.mockReset();
  mockFindShareUser.mockResolvedValue({ ...RECIPIENT });
  mockSendShare.mockResolvedValue(SEND_OK);
});

/* ------------------------------------------------------------------ */
/* THE REGRESSION TEST for 651ac0c                                      */
/* ------------------------------------------------------------------ */

describe('no share request without a search result', () => {
  it('sends NOTHING when every control in the sheet is pressed', async () => {
    // THE test. The old client hardcoded four "Network Peers" carrying real
    // `User` pks 1-4: one tap wrote a `ShareEvent`, bumped the clip's share
    // counter and dropped an unread inbox item into a stranger's account, then
    // rendered a green "Sent". So the assertion is on the ABSENCE of a request
    // across every pressable the sheet renders — not on the presence of an empty
    // state, which is a rendering fact and would survive a data-corruption bug.
    const onClose = jest.fn();
    const r = await renderSheet({ onClose });
    await type(r, 'roastmaster');

    // Every pressable the sheet renders, reached through the real press path: the
    // scrim, the close button, the search button. There is no fourth, and that is
    // the shape of the invariant.
    //
    // `includeHiddenElements` is needed for the scrim and is the assertion that it
    // is hidden from the accessibility tree at all — a default query cannot see it
    // (the VoiceOver-trap argument in the module docstring).
    expect(q(r, SCRIM)).toBeNull();
    await fireEvent.press(r.getByTestId(SCRIM, { includeHiddenElements: true }));
    await fireEvent.press(r.getByTestId(CLOSE));
    await fireEvent.press(r.getByTestId(SUBMIT));
    await settle();

    expect(mockSendShare).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2); // the scrim and the close button
  });

  it('renders no send control at all before a search, so there is nothing to press', async () => {
    const r = await renderSheet();
    expect(q(r, SEND)).toBeNull();
    expect(q(r, RESULT)).toBeNull();
    expect(q(r, USERNAME)).toBeNull();
  });

  it('renders no send control after a search that found nobody', async () => {
    mockFindShareUser.mockRejectedValue(
      new ApiError({ status: 404, body: { error: 'No user found: @nobody' } }),
    );
    const r = await renderSheet();
    await search(r, 'nobody');

    expect(q(r, SEND)).toBeNull();
    expect(q(r, SEARCH_ERROR)).not.toBeNull();
    expect(mockSendShare).not.toHaveBeenCalled();
  });

  it('renders no send control after a search that was refused for being empty', async () => {
    // The local refusal spends no request and leaves no recipient, so there is
    // still nothing to press — and a stale row from an earlier search is gone.
    mockFindShareUser.mockResolvedValue({ ...RECIPIENT });
    const r = await renderSheet();
    await search(r);
    expect(q(r, SEND)).not.toBeNull();

    await type(r, '   ');
    await fireEvent.press(r.getByTestId(SUBMIT));
    await settle();

    expect(q(r, SEND)).toBeNull();
    expect(mockFindShareUser).toHaveBeenCalledTimes(1);
    expect(mockSendShare).not.toHaveBeenCalled();
  });

  it('renders no send control after a search over the length bound', async () => {
    const r = await renderSheet();
    await type(r, 'x'.repeat(FIND_USER_MAX_QUERY + 1));
    await fireEvent.press(r.getByTestId(SUBMIT));
    await settle();

    expect(q(r, SEND)).toBeNull();
    // No request at all: a query longer than `varchar(150)` cannot match, and the
    // 404 would interpolate all 151 characters back into the error body.
    expect(mockFindShareUser).not.toHaveBeenCalled();
    expect(allText(r.getByTestId(SEARCH_ERROR))).toContain(String(FIND_USER_MAX_QUERY));
  });

  it('sends nothing from an empty query even when the previous search DID find someone', async () => {
    // The stale-row rule. A share that goes to the last good search's recipient
    // while the input shows a new name reads on the wire exactly like a share to
    // the person in the input.
    const r = await renderSheet();
    await search(r);
    expect(q(r, SEND)).not.toBeNull();

    await type(r, 'x'.repeat(FIND_USER_MAX_QUERY + 1));
    await fireEvent.press(r.getByTestId(SUBMIT));
    await settle();

    expect(q(r, SEND)).toBeNull();
    expect(mockSendShare).not.toHaveBeenCalled();
  });

  it('sends NOTHING for isShareable: false, with or without a search result', async () => {
    mockFindShareUser.mockResolvedValue({ ...RECIPIENT });
    const r = await renderSheet({ isShareable: false });
    await search(r);

    // Defence in depth: `ActionCluster` refuses to OPEN the sheet for an
    // unshareable clip, so this state is only reachable if the sheet is already
    // open when the clip becomes unshareable. The search still works — looking
    // someone up costs nothing and writes nothing — and the send does not.
    expect(q(r, RESULT)).not.toBeNull();
    expect(q(r, UNAVAILABLE)).not.toBeNull();
    expect(q(r, SEND)).not.toBeNull();
    expect(q(r, SEND)?.props.accessibilityState).toMatchObject({ disabled: true });

    // `disabled` is enforced at the responder boundary, so `fireEvent` is
    // swallowed by the HARNESS here and cannot reach the handler at all. That is
    // the one enforcement point this test cannot observe, and it is why
    // `startSend`'s `not-shareable` refusal is asserted over its whole gate space
    // in `shareDraft.test.ts` rather than here.
    await fireEvent.press(r.getByTestId(SEND));
    await settle();

    expect(mockSendShare).not.toHaveBeenCalled();
  });

  it('states the refusal without claiming to know why', async () => {
    const r = await renderSheet({ isShareable: false });
    const copy = allText(r.getByTestId(UNAVAILABLE));
    expect(copy).toBe(SHARE_UNAVAILABLE_COPY);
    // The `cardStatusReport` rule (ReelCard.tsx:331-342): a caller holding only a
    // UUID learns nothing about moderation or licensing state.
    expect(copy).not.toMatch(/licen|non.?commercial|share.?alike|rights|moderat|attribution/i);
  });
});

/* ------------------------------------------------------------------ */
/* The search                                                           */
/* ------------------------------------------------------------------ */

describe('the search', () => {
  it('shows the STORED username the server sent, never the one that was typed', async () => {
    // `iexact` (views/social.py:169): `ALICE` matched the row stored as `alice`.
    // Rendering the query back would tell a stranger you know their name at a
    // case you guessed at.
    mockFindShareUser.mockResolvedValue({ id: 12, username: 'alice' });
    const r = await renderSheet();
    await search(r, 'ALICE');

    const shown = stringsUnder(r.getByTestId(USERNAME));
    expect(shown).toEqual(['@alice']);
    expect(allText(r.getByTestId(RESULT))).not.toContain('ALICE');
    // …and the id that reaches the send is the one the SERVER sent, which is the
    // only half of this that can corrupt data.
    mockSendShare.mockResolvedValue(SEND_OK);
    await fireEvent.press(r.getByTestId(SEND));
    await settle();
    expect(mockSendShare).toHaveBeenCalledWith(CLIP, 12);
  });

  it('trims before searching and sends the trimmed query', async () => {
    const r = await renderSheet();
    await search(r, '  roastmaster  ');
    expect(mockFindShareUser).toHaveBeenCalledWith('roastmaster');
  });

  it('searches from the keyboard’s search key as well as the button', async () => {
    // One handler behind both, so the two cannot disagree about when a request is
    // made. A sheet with two sources for this fires twice per search.
    const r = await renderSheet();
    await type(r, 'roastmaster');
    await fireEvent(r.getByTestId(INPUT), 'submitEditing');
    await settle();
    expect(mockFindShareUser).toHaveBeenCalledTimes(1);
    expect(q(r, RESULT)).not.toBeNull();
  });

  it('does not spend a second request while one search is in flight', async () => {
    // Weaker than the send guard on purpose: a duplicate lookup costs a round trip
    // and a little `share_poll` budget, and cannot corrupt anything.
    const d = deferred<{ id: number; username: string }>();
    mockFindShareUser.mockReturnValue(d.promise);
    const r = await renderSheet();
    await type(r, 'roastmaster');
    await fireEvent.press(r.getByTestId(SUBMIT));
    expect(q(r, SUBMIT)?.props.accessibilityState).toMatchObject({ busy: true });
    await fireEvent.press(r.getByTestId(SUBMIT));
    expect(mockFindShareUser).toHaveBeenCalledTimes(1);

    await act(async () => {
      d.resolve({ ...RECIPIENT });
      await Promise.resolve();
    });
    await settle();
    expect(q(r, RESULT)).not.toBeNull();
  });

  it('gives a 409 its own message, and it is not the 404’s message', async () => {
    // The web client has no 409 branch and falls through to a generic sentence.
    // The two are the same symptom with opposite causes: nobody has the name,
    // versus two people do and the server refused to guess (views/social.py:174
    // -186). Sending the 404's wording for a 409 tells someone looking for a
    // colleague that the colleague does not exist.
    mockFindShareUser.mockRejectedValue(
      new ApiError({
        status: 409,
        body: {
          error:
            'More than one account matches that username. Try the exact spelling, or ask them to change it.',
        },
      }),
    );
    const ambiguous = await renderSheet();
    await search(ambiguous, 'alice');
    const conflict = allText(ambiguous.getByTestId(SEARCH_ERROR));
    expect(conflict).toBe(LOOKUP_AMBIGUOUS_COPY);

    mockFindShareUser.mockRejectedValue(
      new ApiError({ status: 404, body: { error: 'No user found: @alice' } }),
    );
    const missing = await renderSheet();
    await search(missing, 'alice');
    const notFound = allText(missing.getByTestId(SEARCH_ERROR));

    expect(conflict).not.toBe(notFound);
    expect(notFound).toContain('No user found: @alice');
    expect(conflict).not.toContain('No user found');
  });

  it('names the connection when the search never reached the server', async () => {
    // The old client's one-sentence-for-everything handler told users their
    // username was wrong when the real problem was their connection.
    mockFindShareUser.mockRejectedValue(new ApiError({ status: 0, body: null }));
    const r = await renderSheet();
    await search(r, 'alice');
    expect(allText(r.getByTestId(SEARCH_ERROR))).toMatch(/could not reach the server/i);
  });

  it('explains the empty state rather than rendering a peer list', async () => {
    const r = await renderSheet();
    expect(allText(r.getByTestId(EMPTY))).toMatch(/no contacts or suggestions/i);
    // The old list was four rows carrying real `User` pks 1-4 (651ac0c).
    expect(q(r, RESULT)).toBeNull();
    expect(q(r, SEND)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The send                                                             */
/* ------------------------------------------------------------------ */

describe('the send', () => {
  it('sends exactly one request when the control is pressed twice', async () => {
    // `services/shares.py:31` is an unconditional `ShareEvent.objects.create`, so
    // a second request is a second unread inbox row for a stranger plus a second
    // share-counter bump, and the server never mentions the first.
    const d = deferred<typeof SEND_OK>();
    mockSendShare.mockReturnValue(d.promise);

    const r = await renderSheet();
    await search(r);

    await fireEvent.press(r.getByTestId(SEND));
    await settle();
    expect(mockSendShare).toHaveBeenCalledTimes(1);

    // The second press goes through the REAL press path, not a direct handler
    // call: the control is deliberately NOT `disabled` while in flight
    // (`isSendDisabled`'s docstring), so this is a genuine duplicate tap and the
    // guard that stops it is `startSend`'s `in-flight` branch, not the harness.
    expect(q(r, SEND)?.props.accessibilityState).toMatchObject({ busy: true });
    expect(q(r, SEND)?.props.accessibilityState).toMatchObject({ disabled: false });
    await fireEvent.press(r.getByTestId(SEND));
    await settle();
    expect(mockSendShare).toHaveBeenCalledTimes(1);

    await act(async () => {
      d.resolve(SEND_OK);
      await Promise.resolve();
    });
    await settle();
    expect(sendLabel(r)).toBe('Sent to @roastmaster');
  });

  it('refuses a third press after a successful send, in the same session', async () => {
    mockSendShare.mockResolvedValue(SEND_OK);
    const r = await renderSheet();
    await search(r);
    await fireEvent.press(r.getByTestId(SEND));
    await settle();
    await fireEvent.press(r.getByTestId(SEND));
    expect(mockSendShare).toHaveBeenCalledTimes(1);
    // Now genuinely terminal, so the control is out of the interaction set.
    expect(q(r, SEND)?.props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('says in words that a second send is possible, because the client cannot know', async () => {
    // There is no "what have I sent" endpoint: `GET /share/` is the RECIPIENT's
    // inbox (`views/social.py:90`). A "Sent" badge with no caveat implies a state
    // the client cannot observe — and that badge is what the old client showed for
    // a share that had gone to a stranger.
    const r = await renderSheet();
    await search(r);
    expect(stringsUnder(r.getByTestId('share-resend-notice'))).toEqual([RESEND_NOTICE]);
  });

  it('shows the licence refusal and does NOT read as sent', async () => {
    mockSendShare.mockRejectedValue(
      new ApiError({ status: 403, body: { error: 'This clip may not be shared' } }),
    );
    const r = await renderSheet();
    await search(r);
    await fireEvent.press(r.getByTestId(SEND));
    await settle();

    expect(allText(r.getByTestId(SEND_ERROR))).toBe('This clip may not be shared');
    expect(sendLabel(r)).not.toMatch(/^Sent/);
    // A failed send is retryable by a further TAP, which is a fresh first tap
    // rather than a replay of a request that might have landed.
    expect(q(r, SEND)?.props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('says the clip was not sent when the request never reached the server', async () => {
    mockSendShare.mockRejectedValue(new ApiError({ status: 0, body: null }));
    const r = await renderSheet();
    await search(r);
    await fireEvent.press(r.getByTestId(SEND));
    await settle();
    expect(allText(r.getByTestId(SEND_ERROR))).toMatch(/was not sent/i);
  });

  it('treats a 404 detail as a failure, not as a silent success', async () => {
    // `get_object_or_404` writes `detail`, not `error` (views/social.py:230). A
    // client that reads only `error` renders nothing at all here.
    mockSendShare.mockRejectedValue(new ApiError({ status: 404, body: { detail: 'Not found.' } }));
    const r = await renderSheet();
    await search(r);
    await fireEvent.press(r.getByTestId(SEND));
    await settle();

    expect(q(r, SEND_ERROR)).not.toBeNull();
    expect(allText(r.getByTestId(SEND_ERROR))).toMatch(/could not find what you asked to share/i);
    expect(sendLabel(r)).not.toMatch(/^Sent/);
  });

  it('lets a share to a DIFFERENT person proceed while one is in flight', async () => {
    // The guard is per `(clipId, recipientId)`, so a slow share to one person must
    // not deadlock the sheet — and the second pair has its own key, so its own
    // outcome.
    const d = deferred<typeof SEND_OK>();
    mockSendShare.mockReturnValueOnce(d.promise).mockResolvedValueOnce(SEND_OK);
    mockFindShareUser
      .mockResolvedValueOnce({ id: 8, username: 'eight' })
      .mockResolvedValueOnce({ ...RECIPIENT });

    const r = await renderSheet();
    await search(r, 'eight');
    await fireEvent.press(r.getByTestId(SEND));
    await settle();
    expect(mockSendShare).toHaveBeenCalledTimes(1);

    await search(r, 'roastmaster');
    expect(sendLabel(r)).toBe('Send this clip to @roastmaster');
    await fireEvent.press(r.getByTestId(SEND));
    await settle();
    expect(mockSendShare).toHaveBeenCalledTimes(2);
    expect(mockSendShare).toHaveBeenLastCalledWith(CLIP, RECIPIENT.id);
  });

  it('does not attach a late failure to a different recipient’s row', async () => {
    // The share to #8 fails after the user has searched for #7. Reporting that
    // refusal against #7's row would be a false statement about the action they
    // are about to take — the same ABA hazard `followState.ts` exists for.
    const d = deferred<typeof SEND_OK>();
    mockSendShare.mockReturnValueOnce(d.promise);
    mockFindShareUser
      .mockResolvedValueOnce({ id: 8, username: 'eight' })
      .mockResolvedValueOnce({ ...RECIPIENT });

    const r = await renderSheet();
    await search(r, 'eight');
    await fireEvent.press(r.getByTestId(SEND));
    await settle();

    await search(r, 'roastmaster');
    await act(async () => {
      d.reject(new ApiError({ status: 403, body: { error: 'This clip may not be shared' } }));
      await Promise.resolve();
    });
    await settle();

    expect(q(r, SEND_ERROR)).toBeNull();
    expect(sendLabel(r)).toBe('Send this clip to @roastmaster');
  });
});

/* ------------------------------------------------------------------ */
/* Sent state is local, and resets                                      */
/* ------------------------------------------------------------------ */

describe('the sent state', () => {
  const reachSent = async () => {
    mockSendShare.mockResolvedValue(SEND_OK);
    const r = await renderSheet();
    await search(r);
    await fireEvent.press(r.getByTestId(SEND));
    await settle();
    return r;
  };

  it('resets when the sheet is closed and reopened', async () => {
    const r = await reachSent();
    expect(sendLabel(r)).toBe('Sent to @roastmaster');

    await r.rerender(<ShareModal {...baseProps({ visible: false })} />);
    expect(r.toJSON()).toBeNull();

    await r.rerender(<ShareModal {...baseProps({ visible: true })} />);
    // Structural, not an effect: the state cannot outlive the sheet, so there is
    // no "Sent" for a share made in a previous session and no stale search.
    expect(q(r, USERNAME)).toBeNull();
    expect(q(r, SEND)).toBeNull();
    expect(q(r, EMPTY)).not.toBeNull();
    expect(r.getByTestId(INPUT).props.value).toBe('');
  });

  it('resets when the clip changes while the sheet is open', async () => {
    // The old web sheet keyed "Sent" by RECIPIENT alone and was mounted once for
    // the feed's lifetime, so every later clip showed "Sent" for a clip that was
    // never sent (651ac0c). `key={clipId}` makes state unable to span two clips.
    const r = await reachSent();
    await r.rerender(<ShareModal {...baseProps({ clipId: OTHER_CLIP })} />);

    expect(q(r, USERNAME)).toBeNull();
    expect(q(r, SEND)).toBeNull();
    // And a send on the new clip cannot possibly reuse the old recipient's id.
    mockFindShareUser.mockResolvedValue({ id: 99, username: 'someone-else' });
    await search(r, 'someone-else');
    await fireEvent.press(r.getByTestId(SEND));
    await settle();
    expect(mockSendShare).toHaveBeenLastCalledWith(OTHER_CLIP, 99);
  });

  it('ignores a response that lands after the sheet has closed', async () => {
    const d = deferred<typeof SEND_OK>();
    mockSendShare.mockReturnValue(d.promise);
    const r = await renderSheet();
    await search(r);
    await fireEvent.press(r.getByTestId(SEND));
    await settle();

    await r.rerender(<ShareModal {...baseProps({ visible: false })} />);
    await act(async () => {
      d.resolve(SEND_OK);
      await Promise.resolve();
    });
    await settle();

    await r.rerender(<ShareModal {...baseProps({ visible: true })} />);
    expect(q(r, SEND)).toBeNull();
    expect(r.queryByLabelText(/^Sent to/)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Accessibility and layer                                              */
/* ------------------------------------------------------------------ */

describe('accessibility', () => {
  it('marks the sheet as a modal view, so the reel behind is ignored', async () => {
    // `accessibilityViewIsModal` is RN's `aria-modal`; the web client used
    // `role="dialog" aria-modal="true"` (`ShareModal.tsx:264-268`).
    const r = await renderSheet();
    expect(r.getByTestId(ROOT).props.accessibilityViewIsModal).toBe(true);
  });

  it('renders nothing at all while not visible', async () => {
    const r = await renderSheet({ visible: false });
    expect(r.toJSON()).toBeNull();
  });

  it('labels every control, with a role', async () => {
    const r = await renderSheet();
    await search(r);

    const controls: Array<[string, string]> = [
      [CLOSE, 'Close share sheet'],
      [SUBMIT, 'Search for this username'],
      [SEND, 'Send this clip to @roastmaster'],
    ];
    for (const [testID, label] of controls) {
      const node = r.getByTestId(testID);
      expect({ testID, role: node.props.accessibilityRole }).toEqual({
        testID,
        role: 'button',
      });
      expect(node.props.accessibilityLabel).toBe(label);
    }

    const input = r.getByTestId(INPUT);
    expect(input.props.accessibilityLabel).toBe('Username to search for');
    expect(typeof input.props.accessibilityHint).toBe('string');
    // `autoFocus` is RN's `dialogRef.focus()`: without it the keyboard does not
    // open and the first Tab-equivalent lands outside the sheet.
    expect(input.props.autoFocus).toBe(true);
    expect(r.getByTestId('share-sheet-title').props.accessibilityRole).toBe('header');
  });

  it('announces failures as alerts on a live region', async () => {
    // `NetworkBanner.tsx:24-25` and `ActionCluster.tsx:535-553` are the house
    // pattern; this is the same spelling, on both error slots.
    mockFindShareUser.mockRejectedValue(new ApiError({ status: 404, body: { error: 'No user found: @x' } }));
    const r = await renderSheet();
    await search(r, 'x');
    expect(r.getByTestId(SEARCH_ERROR).props.accessibilityRole).toBe('alert');
    expect(r.getByTestId(SEARCH_ERROR).props.accessibilityLiveRegion).toBe('polite');
  });

  it('offers three dismiss routes: the close button, the scrim, and Android’s back', async () => {
    const onClose = jest.fn();
    const r = await renderSheet({ onClose });

    await fireEvent.press(r.getByTestId(CLOSE));
    expect(onClose).toHaveBeenCalledTimes(1);

    // The scrim is `importantForAccessibility="no-hide-descendants"` — a
    // full-screen invisible button is a VoiceOver trap — so it takes
    // `includeHiddenElements` to query at all.
    await fireEvent.press(r.getByTestId(SCRIM, { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalledTimes(2);

    // Android's hardware back is the third route: `onRequestClose` on the `Modal`,
    // asserted in the layer suite below because it is a Modal prop rather than a
    // press.
  });

  it('hides the scrim from the accessibility tree', async () => {
    const r = await renderSheet();
    expect(q(r, SCRIM)).toBeNull();
    const scrim = r.getByTestId(SCRIM, { includeHiddenElements: true });
    expect(scrim.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(scrim.props.accessibilityElementsHidden).toBe(true);
  });
});

describe('the layer', () => {
  it('uses zIndex.sheet, the token that existed and was unused', async () => {
    const r = await renderSheet();
    expect(styleOf(r.getByTestId(ROOT)).zIndex).toBe(zIndex.sheet);
  });

  it('renders the sheet in a transparent Modal with no status-bar inset', async () => {
    const r = await renderSheet();
    // RN's `Modal` renders a host `Modal` element carrying exactly the props this
    // sheet sets, which is the only handle on the platform contract there is.
    const modal = r.getByTestId(ROOT).parent;
    expect(modal?.props).toMatchObject({
      visible: true,
      transparent: true,
      statusBarTranslucent: true,
    });
    expect(typeof modal?.props.onRequestClose).toBe('function');
  });

  it('gives the header a touch target at the platform floor, not a 20px glyph', async () => {
    // `primitives.ts:MIN_TOUCH_TARGET` — the reason `IconButton` exists at all
    // (the design source's bare `<X size={20}/>` is a 20pt target).
    const r = await renderSheet();
    const style = styleOf(r.getByTestId(CLOSE));
    expect(style.minWidth).toBeGreaterThanOrEqual(20);
    expect(style.minHeight).toBeGreaterThanOrEqual(20);
  });
});
