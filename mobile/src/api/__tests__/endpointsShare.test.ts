import {
  FIND_USER_MAX_QUERY,
  findShareUser,
  isShareAmbiguousUsername,
  isShareLicenceRefused,
  isShareReceiverIdUnusable,
  isShareSelfRefusal,
  sendShare,
  shareErrorMessage,
} from '../endpoints/share';
import { apiFetch } from '../client';

/**
 * Endpoint-shape tests for the two share writes.
 *
 * Most of these pin server behaviour rather than restating the implementation,
 * because both endpoints have a failure mode the status code hides:
 *
 *  - `find-user` can answer **409**, and the web client has no branch for it. A
 *    test that only covered 200 and 404 would pass on a client that renders "no
 *    such user" for a name that two people hold.
 *  - `find-user`'s `id` is an INTEGER `User.pk` while the clip in the same flow is
 *    a UUID, and the mismatch is an unhandled 500 rather than a 400 — so "the
 *    schema rejects a UUID" is a load-bearing assertion, not a type-nerd check.
 *  - `send-share` reports failures under `error` when the view raises them and
 *    under `detail` when `get_object_or_404` does. A client that reads only
 *    `error` renders nothing at all for every 404.
 *
 * The `Object.keys` assertions use the same rule as
 * `endpointsInteractions.test.ts`: DRF silently DROPS unknown fields, so a
 * typo'd or smuggled key is invisible server-side and the parse boundary is the
 * only place it can be caught.
 */

jest.mock('../client', () => ({ apiFetch: jest.fn() }));
const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

/** The real client, for the ApiError instances — `../client` is mocked above. */
const { ApiError } = jest.requireActual<typeof import('../client')>('../client');

/** `AudioClip.id`. A UUID, and the id that must NEVER reach `receiver_id`. */
const CLIP = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  mockApiFetch.mockReset();
});

/* ------------------------------------------------------------------ */
/* findShareUser                                                        */
/* ------------------------------------------------------------------ */

describe('findShareUser', () => {
  const ok = { id: 7, username: 'roastmaster' };

  it('GETs the trailing-slash path with the username as an encoded query param', async () => {
    mockApiFetch.mockResolvedValue(ok);
    await findShareUser('roastmaster');

    expect(mockApiFetch).toHaveBeenCalledWith('/share/find-user/?username=roastmaster');
    // No options object at all, like `getFeedPage`: a GET with no body is also a
    // request with no Content-Type (`client.ts:249`).
    expect(mockApiFetch.mock.calls[0]).toHaveLength(1);
  });

  it('encodes a query that would otherwise change the URL', async () => {
    mockApiFetch.mockResolvedValue(ok);
    await findShareUser('a&b=c#d');

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/share/find-user/?username=a%26b%3Dc%23d',
    );
  });

  it('trims before sending — the server strips, and the length bound is measured on what goes', async () => {
    mockApiFetch.mockResolvedValue(ok);
    await findShareUser('  roastmaster \n');

    expect(mockApiFetch).toHaveBeenCalledWith('/share/find-user/?username=roastmaster');
  });

  it('returns the STORED username the server sent, not the one that was typed', async () => {
    // `iexact` (views/social.py:169), so `ALICE` matches `alice`.
    mockApiFetch.mockResolvedValue({ id: 12, username: 'alice' });
    await expect(findShareUser('ALICE')).resolves.toEqual({ id: 12, username: 'alice' });
  });

  it('rejects a UUID-ish id, because the same value as receiver_id is a 500', async () => {
    // `get_object_or_404(User, id=…)` catches only `DoesNotExist`, so a
    // non-numeric id raises `ValueError` out of the queryset — an unhandled 500,
    // not a 404 and not a 400. The type forbids it; this proves the runtime too.
    mockApiFetch.mockResolvedValue({ id: CLIP, username: 'roastmaster' });
    await expect(findShareUser('roastmaster')).rejects.toThrow();
  });

  it('rejects an id the database could never hold', async () => {
    // A clip UUID in the same flow, a float, and a 0. `AutoField` has produced
    // none of them, and each is a `ValueError` server-side rather than a miss.
    for (const id of ['7', 7.5, 0, -3, null, NaN]) {
      mockApiFetch.mockResolvedValue({ id, username: 'roastmaster' });
      await expect(findShareUser('roastmaster')).rejects.toThrow();
    }
  });

  it('rejects a body that is not the two-key identity object', async () => {
    for (const body of [
      {},
      { id: 7 },
      { username: 'roastmaster' },
      // The paginated `GET /share/` envelope, which is NOT this response.
      { count: 0, next: null, previous: null, results: [] },
    ]) {
      mockApiFetch.mockResolvedValue(body);
      await expect(findShareUser('roastmaster')).rejects.toThrow();
    }
  });

  it('refuses an empty query WITHOUT spending a request', async () => {
    // The server answers 400 `Username required`, so this is belt-and-braces —
    // but the point is that no request is made at all.
    for (const query of ['', '   ', '\n\t']) {
      await expect(findShareUser(query)).rejects.toThrow();
    }
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it(`refuses a query over varchar(${FIND_USER_MAX_QUERY}) WITHOUT spending a request`, async () => {
    // `User.username` is `varchar(150)` (views/social.py:127), so a longer query
    // cannot match anything: every request past the bound is a guaranteed 404
    // whose body interpolates the whole query back (`f'No user found: @{username}'`,
    // :172) — 10 016 characters of error string for a 10 000-character paste.
    await expect(findShareUser('x'.repeat(FIND_USER_MAX_QUERY + 1))).rejects.toThrow();
    expect(mockApiFetch).not.toHaveBeenCalled();

    // And the bound itself is a legal query, so this is a bound and not a
    // "reject anything big" rule.
    mockApiFetch.mockResolvedValue({ id: 7, username: 'x'.repeat(FIND_USER_MAX_QUERY) });
    await expect(
      findShareUser('x'.repeat(FIND_USER_MAX_QUERY)),
    ).resolves.toMatchObject({ id: 7 });
  });

  it('propagates a 409 rather than resolving it as "no such user"', async () => {
    // A real, reachable data state: `username` is unique on a case-SENSITIVE
    // column, so `alice` and `Alice` are both storable and `iexact` matches both
    // (views/social.py:123-127). The view slices at 2 and refuses rather than
    // picking a winner (:174-186).
    mockApiFetch.mockRejectedValue(
      new ApiError({
        status: 409,
        body: {
          error:
            'More than one account matches that username. Try the exact spelling, or ask them to change it.',
        },
      }),
    );

    const outcome = await findShareUser('alice').then(
      () => null,
      (err: unknown) => err,
    );
    expect(outcome).toBeInstanceOf(ApiError);
    expect((outcome as { status: number }).status).toBe(409);
    expect(isShareAmbiguousUsername(outcome)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* sendShare                                                            */
/* ------------------------------------------------------------------ */

describe('sendShare', () => {
  const ok = { status: 'shared successfully' };

  it('POSTs to the trailing-slash path — a GET here is a 405', async () => {
    mockApiFetch.mockResolvedValue(ok);
    await sendShare(CLIP, 7);

    expect(mockApiFetch).toHaveBeenCalledWith(`/share/${CLIP}/send-share/`, {
      method: 'POST',
      body: { receiver_id: 7 },
    });
  });

  it('sends EXACTLY one body key — receiver_id, nothing else', async () => {
    mockApiFetch.mockResolvedValue(ok);
    await sendShare(CLIP, 7);

    const body = mockApiFetch.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    // Object.keys, not toEqual: DRF silently DROPS unknown fields, so a typo'd or
    // smuggled key is invisible server-side and cannot be caught there.
    expect(Object.keys(body)).toEqual(['receiver_id']);
    expect(body.receiver_id).toBe(7);
  });

  it('cannot be made to send anything but receiver_id', async () => {
    mockApiFetch.mockResolvedValue(ok);
    // TypeScript rejects the extra argument; this proves the RUNTIME ignores it
    // too, because `send_share` reads `request.data.get('receiver_id')` and
    // ignores everything else (views/social.py:219).
    // The signature forbids the third argument, so it is reached through a cast —
    // the point of the test is that the RUNTIME ignores it, not that TS allows it.
    const smuggle = sendShare as unknown as (
      clipId: string,
      receiverId: number,
      extra: unknown,
    ) => Promise<unknown>;
    await smuggle(CLIP, 7, { receiver_id: 1, is_read: true });

    const body = mockApiFetch.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['receiver_id']);
    expect(body.receiver_id).toBe(7);
  });

  it('switches on the string, and the string is not "shared"', async () => {
    // 201 is not observable from here — `apiFetch` returns the parsed body and
    // throws on non-2xx (client.ts:304-335) — so the literal is the whole signal.
    for (const status of ['shared', 'shared_successfully', 'Shared successfully', 'ok', '']) {
      mockApiFetch.mockResolvedValue({ status });
      await expect(sendShare(CLIP, 7)).rejects.toThrow();
    }
  });

  it('REJECTS an empty body rather than accepting a 201 as a success', async () => {
    mockApiFetch.mockResolvedValue({});
    await expect(sendShare(CLIP, 7)).rejects.toThrow();
  });

  it('exposes no share id, no receiver and no count, because the server sends none', async () => {
    // `{'status': …}` and nothing else (views/social.py:250). A count would have
    // to come from `FeedClip.shares`, which is flushed on a 5-minute Celery beat.
    mockApiFetch.mockResolvedValue(ok);
    await expect(sendShare(CLIP, 7)).resolves.toEqual({ status: 'shared successfully' });
  });

  it('propagates a refused write instead of swallowing it', async () => {
    // 403 licence · 404 detail · 400 self · 429 over `share_send: 100/hour`. All
    // of them arrive as throws, and a caller that rendered a refusal as a success
    // would be telling a third party they have audio they were never sent.
    for (const status of [400, 403, 404, 429, 500]) {
      mockApiFetch.mockRejectedValue(new ApiError({ status, body: { error: 'nope' } }));
      await expect(sendShare(CLIP, 7)).rejects.toThrow();
    }
  });

  it('does NOT stop a UUID receiver_id — the guard is upstream, and that is stated', async () => {
    // The type is `number` and the only producer of one is the parsed `find-user`
    // body, so this cannot be reached from the app. Asserting the passthrough
    // anyway, because the alternative is a reader assuming there is a second
    // check here: there is not. `get_object_or_404(User, id=…)` catches only
    // `DoesNotExist`, so this value is an unhandled 500 in production
    // (`isShareReceiverIdUnusable`'s docstring is what a UI would read it with).
    mockApiFetch.mockResolvedValue(ok);
    const smuggle = sendShare as unknown as (clipId: string, receiverId: unknown) => Promise<unknown>;
    await smuggle(CLIP, CLIP);

    expect(mockApiFetch).toHaveBeenCalledWith(`/share/${CLIP}/send-share/`, {
      method: 'POST',
      body: { receiver_id: CLIP },
    });
  });

  it('a UUID receiver_id in production is a 500, which the UI reads as a malformed id', async () => {
    // The pair of assertions, end to end: the request goes out, the server 500s,
    // and `isShareReceiverIdUnusable` is what lets the sheet say "this clip cannot
    // be shared" rather than "try again" — a retry reproduces the same 500.
    mockApiFetch.mockRejectedValue(new ApiError({ status: 500, body: null }));
    const outcome = await sendShare(CLIP, 7).then(
      () => null,
      (err: unknown) => err,
    );
    expect(isShareReceiverIdUnusable(outcome)).toBe(true);
    expect(isShareLicenceRefused(outcome)).toBe(false);
    expect(shareErrorMessage(outcome)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Error classification                                                 */
/* ------------------------------------------------------------------ */

describe('shareErrorMessage', () => {
  it('reads the view’s own key, `error`', () => {
    expect(
      shareErrorMessage(
        new ApiError({ status: 403, body: { error: 'This clip may not be shared' } }),
      ),
    ).toBe('This clip may not be shared');
  });

  it('reads DRF’s key, `detail`, which send-share also uses', () => {
    // `get_object_or_404` → `{"detail": "Not found."}` (views/social.py:230,238).
    // A client that reads only `error` renders NOTHING for every 404, and a blank
    // sheet is not a failure message.
    expect(
      shareErrorMessage(new ApiError({ status: 404, body: { detail: 'Not found.' } })),
    ).toBe('Not found.');
  });

  it('prefers `error` over `detail` when both are present', () => {
    expect(
      shareErrorMessage(new ApiError({ status: 404, body: { detail: 'Not found.', error: 'gone' } })),
    ).toBe('gone');
  });

  it('returns null for a body with neither key, and for a missing body', () => {
    expect(shareErrorMessage(new ApiError({ status: 500, body: null }))).toBeNull();
    expect(shareErrorMessage(new ApiError({ status: 500, body: { field: ['x'] } }))).toBeNull();
    expect(shareErrorMessage(new ApiError({ status: 500, body: 'plain text' }))).toBeNull();
    expect(shareErrorMessage(null)).toBeNull();
    expect(shareErrorMessage(undefined)).toBeNull();
    expect(shareErrorMessage('error: nope')).toBeNull();
  });

  it('refuses to turn an HTML error page into copy', async () => {
    // A 5xx with a non-JSON content type puts the whole page in the body
    // (client.ts:308-310). Rendering that to a human is worse than saying nothing.
    const html = new ApiError({ status: 500, body: '<!DOCTYPE html><h1>Server Error (500)</h1>' });
    expect(shareErrorMessage(html)).toBeNull();
    // And through the endpoint, so the helper is pinned to the error the endpoint
    // actually rejects with rather than to a hand-built shape.
    mockApiFetch.mockRejectedValue(html);
    const outcome = await sendShare(CLIP, 7).then(
      () => null,
      (err: unknown) => err,
    );
    expect(shareErrorMessage(outcome)).toBeNull();
  });

  it('trims, and treats an empty or whitespace value as no message', () => {
    expect(shareErrorMessage({ body: { error: '  spaced  ' } })).toBe('spaced');
    expect(shareErrorMessage({ body: { error: '   ' } })).toBeNull();
    expect(shareErrorMessage({ body: { error: 42 } })).toBeNull();
  });
});

describe('isShareAmbiguousUsername', () => {
  it('is true for a 409, structural and not instanceof', async () => {
    // `apiFetch` is mocked, so the only real ApiError in play is a required
    // one: the predicate must not depend on there being exactly one class
    // instance in the process.
    mockApiFetch.mockRejectedValue(
      new ApiError({ status: 409, body: { error: 'More than one account matches…' } }),
    );
    const outcome = await findShareUser('alice').then(
      () => null,
      (err: unknown) => err,
    );
    expect(isShareAmbiguousUsername(outcome)).toBe(true);
    expect(isShareAmbiguousUsername({ status: 409 })).toBe(true);
  });

  it('is false for every other status these endpoints can produce', () => {
    for (const status of [0, 200, 400, 401, 403, 404, 429, 500, 502]) {
      expect(isShareAmbiguousUsername({ status })).toBe(false);
    }
  });

  it('is false for a non-object, and does not throw on a missing status', () => {
    expect(isShareAmbiguousUsername(null)).toBe(false);
    expect(isShareAmbiguousUsername('409')).toBe(false);
    expect(isShareAmbiguousUsername(409)).toBe(false);
    expect(isShareAmbiguousUsername({})).toBe(false);
    expect(isShareAmbiguousUsername({ status: '409' })).toBe(false);
  });
});

describe('isShareSelfRefusal', () => {
  it('is true for the server’s own sentence under either key', () => {
    // `views/social.py:190` (find-user) and `:226` (send-share) are byte-identical.
    expect(
      isShareSelfRefusal(new ApiError({ status: 400, body: { error: "You can't share with yourself" } })),
    ).toBe(true);
    expect(
      isShareSelfRefusal({ status: 400, body: { detail: "You can't share with yourself." } }),
    ).toBe(true);
  });

  it('is FALSE for find-user’s other 400, which says the opposite thing', () => {
    // A status-only predicate would be true here, and the user would be told they
    // cannot share with themselves when the real answer is "type a username".
    // The two 400s are told apart by the sentence, not the code.
    expect(
      isShareSelfRefusal(new ApiError({ status: 400, body: { error: 'Username required' } })),
    ).toBe(false);
  });

  it('is false for send-share’s other 400', () => {
    expect(
      isShareSelfRefusal(new ApiError({ status: 400, body: { error: 'Receiver ID required' } })),
    ).toBe(false);
  });

  it('is false for any other status, even carrying the same sentence', () => {
    // A 403 that happened to quote it would not be a self-share refusal.
    expect(isShareSelfRefusal({ status: 403, body: { error: "You can't share with yourself" } })).toBe(
      false,
    );
  });

  it('is false for a non-object and a bodyless error', () => {
    expect(isShareSelfRefusal(null)).toBe(false);
    expect(isShareSelfRefusal('nope')).toBe(false);
    expect(isShareSelfRefusal(new ApiError({ status: 400, body: null }))).toBe(false);
  });
});

describe('isShareLicenceRefused', () => {
  it('is true for a 403 from send-share', () => {
    expect(
      isShareLicenceRefused(
        new ApiError({ status: 403, body: { error: 'This clip may not be shared' } }),
      ),
    ).toBe(true);
  });

  it('is false for every other status, including 404 — the two are different facts', () => {
    // A 404 means the clip left the servable set; a 403 means its rights forbid
    // sharing. The COPY may collapse them (cardStatusReport does), but the
    // classifier must not, or a deleted clip renders as a rights refusal.
    for (const status of [0, 400, 401, 404, 409, 429, 500]) {
      expect(isShareLicenceRefused({ status })).toBe(false);
    }
  });

  it('identifies the refusal from a live sendShare call', async () => {
    mockApiFetch.mockRejectedValue(
      new ApiError({ status: 403, body: { error: 'This clip may not be shared' } }),
    );
    const outcome = await sendShare(CLIP, 7).then(
      () => null,
      (err: unknown) => err,
    );
    expect(outcome).toBeInstanceOf(ApiError);
    expect(isShareLicenceRefused(outcome)).toBe(true);
  });

  it('is true for a plain object carrying status 403 — no ApiError instance involved', () => {
    // Structural by design, and the same reason `isTelemetryRefusedForMinor` and
    // `isFollowSelfRefusal` are structural: under Metro's module duplication or
    // across a jest module-mock boundary, `instanceof` is a boolean that flips for
    // reasons unrelated to the response.
    const impostor = { status: 403, body: { error: 'This clip may not be shared' } };
    expect(impostor instanceof ApiError).toBe(false);
    expect(isShareLicenceRefused(impostor)).toBe(true);
  });

  it('is false for a non-object', () => {
    expect(isShareLicenceRefused(null)).toBe(false);
    expect(isShareLicenceRefused(403)).toBe(false);
    expect(isShareLicenceRefused('403')).toBe(false);
  });
});

describe('isShareReceiverIdUnusable', () => {
  it('is true for a 500, which is what a malformed id produces', () => {
    // `get_object_or_404` catches only `DoesNotExist`; a non-numeric pk raises
    // `ValueError` out of the queryset and DRF turns it into a 500.
    expect(isShareReceiverIdUnusable(new ApiError({ status: 500, body: null }))).toBe(true);
  });

  it('is false for a 429 and everything else, so a throttled send is not a 500', () => {
    for (const status of [0, 400, 401, 403, 404, 409, 429, 502, 503]) {
      expect(isShareReceiverIdUnusable({ status })).toBe(false);
    }
  });

  it('is false for a network failure, which has no status at all', () => {
    // `apiFetch` maps a transport failure to `status: 0` (client.ts:284), and a
    // timeout to the same shape. Those are retryable; a malformed id is not.
    expect(isShareReceiverIdUnusable(new ApiError({ status: 0, body: null }))).toBe(false);
    expect(isShareReceiverIdUnusable(null)).toBe(false);
  });
});
