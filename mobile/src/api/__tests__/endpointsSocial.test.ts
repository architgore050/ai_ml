import { isFollowSelfRefusal, toggleFollow } from '../endpoints/social';
import { feedClipSchema } from '../schema';
import { apiFetch } from '../client';

/**
 * Endpoint-shape tests for the follow toggle.
 *
 * Most of these pin server behaviour rather than restating the implementation,
 * because a 2xx hides a great deal on this endpoint:
 *
 *  - `POST /follow/{pk}/toggle-follow/` takes an INTEGER `User.pk`. A non-numeric
 *    one is an **unhandled 500**, not a 404 — `get_object_or_404(User, pk=…)`
 *    catches `DoesNotExist` and nothing else (`views/social.py:288`).
 *  - 201 and 200 carry the same shape. Only the `status` string distinguishes
 *    them, and the code is not reachable by any caller of this module.
 *  - There is no follower count in the response, and inventing one would put a
 *    guess in the UI next to a true number on `GET /profile/{id}/`.
 *  - `FollowViewSet` has no `throttle_scope`, so `ScopedRateThrottle` is a
 *    silent no-op and all debouncing is the client's job. That is a property of
 *    the backend, asserted below so a backend change that adds a scope fails
 *    here rather than making a comment quietly true.
 */

jest.mock('../client', () => ({ apiFetch: jest.fn() }));
const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

/** The real client, for the ApiError instances — `../client` is mocked above. */
const { ApiError } = jest.requireActual<typeof import('../client')>('../client');

/** An integer `User.pk`, as `FeedClip.creator_id` carries. */
const CREATOR = 42;

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('the id in the path', () => {
  it('is an integer User.pk, because FeedClip.creator_id is a z.number()', async () => {
    // The trap this file exists to catch. `FeedClip.id` — one line above
    // `creator_id` in the same object — is a UUID string. Passing it here is a
    // 500 from the backend, not a 404.
    const clip = feedClipSchema.parse({
      id: '11111111-1111-1111-1111-111111111111',
      title: 'a clip',
      creator_name: 'alice',
      creator_id: CREATOR,
      category: 'music',
      hls_playlist_url: null,
      likes: 0,
      shares: 0,
      skips: 0,
      comment_count: 0,
      is_liked: false,
    });

    expect(typeof clip.id).toBe('string');
    expect(typeof clip.creator_id).toBe('number');

    mockApiFetch.mockResolvedValue({ status: 'followed' });
    await toggleFollow(clip.creator_id);

    // The number is interpolated bare, so the path carries `42` and not a UUID.
    expect(mockApiFetch).toHaveBeenCalledWith('/follow/42/toggle-follow/', {
      method: 'POST',
    });
    expect(mockApiFetch.mock.calls[0]?.[0]).not.toContain(clip.id);
  });

  it('sends the id it is given, with no rounding, coercion or validation', async () => {
    // Deliberately NO defensive normalisation here. The client-side guard that
    // keeps a garbage id off the wire is `followState.hydrateFollowState`, which
    // turns a non-integer into `null` and then refuses the press. Silently
    // coercing here would mean a UUID became `NaN` in a URL and still 500'd —
    // it would only move the failure, and it would remove the caller's ability
    // to see that it passed the wrong thing.
    mockApiFetch.mockResolvedValue({ status: 'followed' });
    await toggleFollow(CREATOR);
    expect(mockApiFetch.mock.calls[0]?.[0]).toBe(`/follow/${CREATOR}/toggle-follow/`);
  });
});

describe('toggleFollow', () => {
  it('POSTs to the trailing-slash path with no body', async () => {
    mockApiFetch.mockResolvedValue({ status: 'followed' });
    await toggleFollow(CREATOR);

    expect(mockApiFetch).toHaveBeenCalledWith('/follow/42/toggle-follow/', {
      method: 'POST',
    });
    // Not `body: undefined` either: `apiFetch` keys Content-Type off
    // `body !== undefined` (client.ts:249), and `toggle_follow` never reads
    // `request.data` at all (views/social.py:290-296) — so a body would be a
    // key the server silently drops.
    const options = mockApiFetch.mock.calls[0]?.[1];
    expect(options).not.toHaveProperty('body');
  });

  it.each([
    ['followed', 'followed'],
    ['unfollowed', 'unfollowed'],
  ])('returns the parsed server value %s', async (wire, expected) => {
    mockApiFetch.mockResolvedValue({ status: wire });
    await expect(toggleFollow(CREATOR)).resolves.toEqual({ status: expected });
  });

  it('REJECTS a status outside the two the server can produce', async () => {
    // `toggle_follow` returns the literal result of `follows_svc.toggle_follow`
    // (views/social.py:293-294), which is 'followed' or 'unfollowed'. A third
    // value is a backend change and must fail here rather than reach a button
    // as an unknown state — a button with a third state would toggle on it, and
    // a toggle on an unknown state is a coin flip against a real FK row.
    for (const bogus of ['follow', 'unfollow', 'following', 'FOLLOWED', '']) {
      mockApiFetch.mockResolvedValue({ status: bogus });
      await expect(toggleFollow(CREATOR)).rejects.toThrow();
    }
  });

  it('REJECTS an empty body rather than treating it as a no-op toggle', async () => {
    // A toggle always changes something. A body with no status means the
    // contract moved and the client must not conclude it followed anyone.
    mockApiFetch.mockResolvedValue({});
    await expect(toggleFollow(CREATOR)).rejects.toThrow();
  });

  it('carries NO follower count, because the server sends none', async () => {
    // `followers_count` is an annotated read-only field on the PROFILE
    // serializer (serializers.py:1063), not on this response. A count here
    // would be a number the toggle cannot have moved, next to a true number on
    // `GET /profile/{id}/`.
    mockApiFetch.mockResolvedValue({ status: 'followed' });
    const result = await toggleFollow(CREATOR);
    expect(Object.keys(result)).toEqual(['status']);
    expect(result).not.toHaveProperty('followers_count');
    expect(result).not.toHaveProperty('count');
  });

  it('STRIPS a count that arrives alongside a valid status, so it cannot reach a caller', () => {
    // Worth stating precisely, because the instinct is to assert a REJECTION
    // here and that test would pass for the wrong reason: zod's `.object()`
    // strips undeclared keys rather than failing on them. So if the backend ever
    // started sending `followers_count` on this response, this module would not
    // error — it would drop the field, and the parsed result would still be
    // `{status}`.
    //
    // That is the right direction to fail in for a TOGGLE: a caller cannot be
    // corrupted by a field it cannot see, and a stale count rendered next to a
    // live button is exactly the divergence `carries NO follower count` above is
    // about. The tripwire for an unexpected field is the `Object.keys` assertion
    // on the RESULT, not on the wire body.
    //
    // (The contrast with `cursorSchema` in `api/schema.ts:44-60`, which wants
    // `.strict()` on purpose: there the ambiguity is which envelope shape
    // arrived, and either reading is actionable. Here the extra field would be
    // inert.)
    mockApiFetch.mockResolvedValue({ status: 'followed', followers_count: 12 });

    return toggleFollow(CREATOR).then((result) => {
      expect(result).toEqual({ status: 'followed' });
      expect(Object.keys(result)).toEqual(['status']);
      expect(result).not.toHaveProperty('followers_count');
    });
  });

  it('exposes NO channel through which the HTTP status code could be read', async () => {
    // THE rule, asserted as a shape rather than as prose.
    //
    // 201 + `{"status": "followed"}` and 200 + `{"status": "unfollowed"}` are
    // the two real pairs, but the pairing is not binding — the same body is
    // legal on either code. A client that branched on the code would mislabel
    // half its results; the web client's own type is
    // `Promise<{status: "followed"|"unfollowed"}>` for exactly this reason.
    //
    // The stronger statement is that it is not *possible*: `apiFetch` returns
    // the parsed body and throws on non-2xx (client.ts:304-335), so the code is
    // erased at the transport boundary and never reaches this module. The
    // return object has one key and it is a string; the request options have no
    // slot a code could come back in.
    mockApiFetch.mockResolvedValue({ status: 'followed' });
    const result = await toggleFollow(CREATOR);

    expect(Object.keys(result)).toEqual(['status']);
    expect(typeof result.status).toBe('string');

    const options = mockApiFetch.mock.calls[0]?.[1] ?? {};
    expect(Object.keys(options).sort()).toEqual(['method']);
  });

  it('propagates a failure rather than swallowing it', async () => {
    // 401 · 404 · 429 · 500 all arrive here as throws. `failFollow` needs them:
    // a swallowed rejection would leave `pending` true for the life of the
    // component and the button would stay dead.
    mockApiFetch.mockRejectedValue(new ApiError({ status: 500, body: { detail: 'boom' } }));
    await expect(toggleFollow(CREATOR)).rejects.toThrow();
  });
});

describe('isFollowSelfRefusal', () => {
  it('is true for the 400 the server returns for a self-follow', async () => {
    // views/social.py:291 — `{'error': 'You cannot follow yourself.'}`, trailing
    // period. Refusing self-follow is correct behaviour, so this must be a
    // distinct outcome and not a generic failure: nothing failed, nothing needs
    // retrying, and "could not update follow" would be a lie about it.
    mockApiFetch.mockRejectedValue(
      new ApiError({ status: 400, body: { error: 'You cannot follow yourself.' } }),
    );

    const outcome = await toggleFollow(CREATOR).then(
      () => null,
      (err: unknown) => err,
    );

    expect(outcome).toBeInstanceOf(ApiError);
    expect(isFollowSelfRefusal(outcome)).toBe(true);
  });

  it('is true for a plain object carrying status 400', () => {
    // Structural by design, and the same deliberate difference from
    // `auth.ts` that `isTelemetryRefusedForMinor` documents: under Metro's
    // module duplication or across a jest `mock('../client')` boundary,
    // `instanceof` flips for reasons unrelated to the response.
    expect(isFollowSelfRefusal({ status: 400 })).toBe(true);
  });

  it('is false for every other status this endpoint can produce', () => {
    // 401 not signed in · 404 no such user · 429 over `user: 1000/hour` ·
    // 500 unhandled. 0 is what `apiFetch` synthesises for a network failure and
    // an abort, and neither is a refusal — the caller's `error` field should say
    // the write failed, not that the user tried to follow themselves.
    for (const status of [401, 403, 404, 429, 500, 0]) {
      expect(isFollowSelfRefusal({ status })).toBe(false);
    }
  });

  it('is false for a non-object, and does not throw on a status-less object', () => {
    expect(isFollowSelfRefusal(null)).toBe(false);
    expect(isFollowSelfRefusal(undefined)).toBe(false);
    expect(isFollowSelfRefusal('400')).toBe(false);
    expect(isFollowSelfRefusal(400)).toBe(false);
    expect(isFollowSelfRefusal({})).toBe(false);
    expect(isFollowSelfRefusal({ status: '400' })).toBe(false);
    expect(isFollowSelfRefusal({ status: null })).toBe(false);
  });

  it('does not claim a 404 is a refusal, even though both mean "no such thing"', async () => {
    // 404 is `get_object_or_404(User, pk=…)` — the target does not exist. 400 is
    // the target being you. Collapsing them would render "you cannot follow
    // yourself" on a card whose creator was deleted.
    mockApiFetch.mockRejectedValue(
      new ApiError({ status: 404, body: { detail: 'Not found.' } }),
    );
    const outcome = await toggleFollow(999_999).then(
      () => null,
      (err: unknown) => err,
    );
    expect(isFollowSelfRefusal(outcome)).toBe(false);
  });
});

describe('no retry, because there is no throttle scope to respect and no key to retry with', () => {
  it('one press is exactly one request — this module never re-issues it', async () => {
    // `FollowViewSet` (views/social.py:280-296) declares no `throttle_classes`
    // and no `throttle_scope`, so it inherits DEFAULT_THROTTLE_CLASSES
    // (settings.py:876-880). `ScopedRateThrottle.allow_request` returns True
    // immediately when the view has no scope (throttling.py:219-225) — a silent
    // no-op, not an error. `AnonRateThrottle` is skipped outright for an
    // authenticated caller (throttling.py:173-175), leaving `user: 1000/hour`
    // as the only limit, keyed on the user pk.
    //
    // That is a generous budget on an endpoint with no concurrency guard
    // (`services/follows.py:16-22` is a read-then-write on an M2M), so the retry
    // discipline has to live here — and "here" means nowhere, which is the point.
    // Two in-flight POSTs for one pair both observe `exists() == False` and both
    // `add`, so the user watches the button not move. A retry that cannot see the
    // response (5xx, timeout, abort) may also have committed, and re-issuing a
    // toggle whose first execution you never saw flips it back.
    //
    // The single safe re-issue is `apiFetch`'s own 401-refresh-and-replay
    // (client.ts:314-322), and it is safe structurally: DRF raises the 401 in
    // `APIView.initial()` before `dispatch()` reaches the action, so the replay
    // is the FIRST execution of the toggle. A retry loop added here would break
    // that property; this assertion is what makes it visible.
    mockApiFetch.mockResolvedValue({ status: 'followed' });
    await toggleFollow(CREATOR);
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failure either', async () => {
    // The web client retries nothing and neither does this, but the property is
    // worth pinning from the failure side: a 500 on a toggle is exactly the case
    // where a "helpful" retry silently unfollows.
    mockApiFetch.mockRejectedValue(new ApiError({ status: 500, body: { detail: 'boom' } }));
    await expect(toggleFollow(CREATOR)).rejects.toThrow();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });
});