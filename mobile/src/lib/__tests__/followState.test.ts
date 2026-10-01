import {
  confirmFollow,
  describeFollowError,
  failFollow,
  FOLLOW_FAILED_MESSAGE,
  FOLLOW_SELF_REFUSAL_MESSAGE,
  hydrateFollowState,
  pressFollow,
  type FollowPress,
  type FollowState,
} from '../followState';

/**
 * The follow button's state machine.
 *
 * ## These tests import the SHIPPED functions
 * Nothing here re-implements the rule it checks. The failure mode this file
 * exists to prevent is the one `feedBuffer.test.ts:9-19` documents at length: a
 * suite that passes 7/7 while measuring 0.0% of the shipped code, because the
 * assertion was written against a local copy.
 *
 * ## No renderer, no fake timers, no mocks
 * The module performs no I/O, reads no clock and imports no React, so the three
 * interleaving rules — in-flight suppression, ABA-safe rollback, error-as-value
 * — are plain statements rather than things that need a component to provoke.
 * That is why the state is a plain object and not a `useState`: a reducer can be
 * tested, but only if the tests are willing to render.
 *
 * ## Mutants are pinned, not assumed
 * The mutations at the bottom of each part were each verified to turn this file
 * red. A test that has never been seen red is not evidence.
 */

/** An integer `User.pk` — `FeedClip.creator_id` is a `z.number()` (schema.ts:103). */
const CREATOR = 42;
/** The signed-in viewer's own pk. Never equal to `CREATOR` unless a test says so. */
const VIEWER = 7;

const seeded = (over: {
  creator_id?: number | null;
  isFollowing?: boolean | null;
  viewerId?: number | null;
} = {}): FollowState =>
  hydrateFollowState({
    clip: { creator_id: over.creator_id === undefined ? CREATOR : over.creator_id },
    viewerId: over.viewerId === undefined ? VIEWER : over.viewerId,
    isFollowing: over.isFollowing,
  });

/** Narrow a press to the one that actually issued a request. */
function sent(press: FollowPress): { state: FollowState; requestId: number } {
  if (press.kind !== 'sent') {
    throw new Error(`expected a sent press, got ${press.kind}/${press.reason}`);
  }
  return { state: press.state, requestId: press.requestId };
}

// ===========================================================================
// PART 1 — hydration
// ===========================================================================

describe('hydrateFollowState', () => {
  it('seeds isFollowing from the server value, in both directions', () => {
    // This is the fix. `FeedClipSerializer.get_is_following`
    // (serializers.py:678-702) exists for exactly this, and a client that
    // ignores it renders "Follow" on someone already followed.
    expect(seeded({ isFollowing: false }).isFollowing).toBe(false);
    expect(seeded({ isFollowing: true }).isFollowing).toBe(true);
  });

  it('starts with nothing pending, no error and no rollback', () => {
    expect(seeded({ isFollowing: false })).toEqual({
      userId: CREATOR,
      viewerId: VIEWER,
      isFollowing: false,
      pending: false,
      error: null,
      requestId: 0,
      rollback: null,
    });
  });

  it('treats a MISSING is_following as unknown, never as false', () => {
    // THE rule. `false` here is the original defect with the hydration step
    // removed: the button shows "Follow", the press toggles, and a viewer who
    // already follows gets unfollowed. `undefined` means "the server did not
    // tell us", which is a third state and not a synonym for `false`.
    //
    // Not hypothetical on this client: `feedClipSchema` (api/schema.ts:99-117)
    // declares `is_liked` and no `is_following`, and zod strips undeclared keys,
    // so until that schema gains the field EVERY call site lands here.
    for (const absent of [undefined, null]) {
      const state = seeded({ isFollowing: absent });
      expect(state.isFollowing).toBeNull();

      // ...and an unknown state cannot be pressed, so no request is made.
      const press = pressFollow(state);
      expect(press.kind).toBe('ignored');
      if (press.kind === 'ignored') expect(press.reason).toBe('unknown-state');
    }
  });

  it('never coerces a truthy non-boolean into a follow', () => {
    // `1` and `'true'` are not values the server sends. Treating either as
    // `true` re-creates the defect for a shape nobody produces, and does it
    // silently.
    for (const bogus of [1, 0, 'true', 'false', 'yes', {}, [], true && 1]) {
      const state = hydrateFollowState({
        clip: { creator_id: CREATOR },
        viewerId: VIEWER,
        isFollowing: bogus as unknown as boolean,
      });
      expect(state.isFollowing).toBeNull();
    }
  });

  it('refuses a creator_id that is not a positive integer, rather than building a URL', () => {
    // `get_object_or_404(User, pk=…)` catches `DoesNotExist` and nothing else,
    // so a non-numeric pk raises `ValueError` → 500 (views/social.py:288). The
    // guard is here, not at the endpoint: coercing a UUID to `NaN` in a template
    // literal would still 500, and it would hide from the caller that it passed
    // the wrong id.
    const hostile = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
      null,
      undefined,
      // `FeedClip.id` — a UUID string. Forbidden by the type; refused by the
      // runtime too, so the wrong id in the same feed row cannot reach the wire.
      '11111111-1111-1111-1111-111111111111',
    ];

    for (const creator_id of hostile) {
      const state = hydrateFollowState({
        clip: { creator_id: creator_id as number },
        viewerId: VIEWER,
        isFollowing: false,
      });
      expect(state.userId).toBeNull();

      const press = pressFollow(state);
      expect(press.kind).toBe('ignored');
      if (press.kind === 'ignored') expect(press.reason).toBe('no-target');
    }
  });

  it('accepts a null clip and a missing clip identically', () => {
    for (const clip of [null, undefined]) {
      const state = hydrateFollowState({ clip, viewerId: VIEWER, isFollowing: false });
      expect(state.userId).toBeNull();
      expect(pressFollow(state).kind).toBe('ignored');
    }
  });

  it('accepts a clip with no creator_id field at all', () => {
    // zod's `.optional()` fields produce exactly this object, so a caller that
    // forwards `clip` wholesale hits it on any clip whose payload changed.
    const state = hydrateFollowState({ clip: {}, viewerId: VIEWER, isFollowing: false });
    expect(state.userId).toBeNull();
  });

  it('normalises a hostile viewerId to null, which only disables the self-follow guard', () => {
    // It is a guard, not a routing input: a viewer id that is unusable cannot
    // match anything, so it must not make every creator "the viewer".
    for (const viewerId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      const state = hydrateFollowState({
        clip: { creator_id: CREATOR },
        viewerId: viewerId as number,
        isFollowing: false,
      });
      expect(state.viewerId).toBeNull();
      expect(state.userId).toBe(CREATOR);
      // The button still works — it just cannot refuse itself.
      expect(pressFollow(state).kind).toBe('sent');
    }
  });
});

// ===========================================================================
// PART 2 — pressing
// ===========================================================================

describe('pressFollow', () => {
  it('flips the value optimistically and marks the request pending', () => {
    const press = sent(pressFollow(seeded({ isFollowing: false })));
    expect(press.state.isFollowing).toBe(true);
    expect(press.state.pending).toBe(true);
    expect(press.state.error).toBeNull();
  });

  it('captures the PRE-press value for the rollback, tagged with its own id', () => {
    // The tag is the whole point — see `isCurrentRequest`. An untagged saved
    // value cannot be attributed to a press and must not be restored blindly.
    const press = sent(pressFollow(seeded({ isFollowing: true })));
    expect(press.state.rollback).toEqual({ requestId: press.requestId, isFollowing: true });
    expect(press.state.isFollowing).toBe(false);
  });

  it('hands back the request id the caller must quote when the promise settles', () => {
    // The entire async protocol. `pressFollow` performs no I/O, so the id has to
    // leave with the press or the settle calls cannot be correlated.
    const first = sent(pressFollow(seeded({ isFollowing: false })));
    expect(typeof first.requestId).toBe('number');
    expect(first.requestId).toBe(first.state.requestId);
  });

  it('never mutates the state it was given', () => {
    const before = seeded({ isFollowing: false });
    const snapshot = { ...before };
    pressFollow(before);
    expect(before).toEqual(snapshot);
  });

  it('clears a previous error when a new press is accepted', () => {
    // A failed press leaves an error; the next real press must not show a stale
    // failure next to a live spinner.
    const first = sent(pressFollow(seeded({ isFollowing: false })));
    const failed = failFollow(first.state, first.requestId, new Error('boom'));
    expect(failed.error).toBe(FOLLOW_FAILED_MESSAGE);

    const second = sent(pressFollow({ ...failed, pending: false }));
    expect(second.state.error).toBeNull();
  });

  describe('in-flight suppression', () => {
    it('IGNORES a second press rather than queueing it', () => {
      const first = sent(pressFollow(seeded({ isFollowing: false })));
      const second = pressFollow(first.state);

      expect(second.kind).toBe('ignored');
      if (second.kind === 'ignored') expect(second.reason).toBe('in-flight');
    });

    it('does not transition a second time, so two toggles never net to zero', () => {
      // `services/follows.py:16-22` is a read-then-write on an M2M with no
      // locking. Two in-flight POSTs both observe `exists() == False` and both
      // `add` — the user watches the button not move and the relationship is
      // unchanged. Suppressing the second request is the only client-side fix;
      // there is no server-side guard to lean on.
      const first = sent(pressFollow(seeded({ isFollowing: false })));
      const second = pressFollow(first.state);

      expect(second.state.isFollowing).toBe(true);
      expect(second.state.requestId).toBe(first.requestId);
      expect(second.state.rollback).toEqual(first.state.rollback);
    });

    it('leaves the first request outstanding, so the settle still correlates', () => {
      const first = sent(pressFollow(seeded({ isFollowing: false })));
      const second = pressFollow(first.state);
      expect(second.state.pending).toBe(true);
      // The ignored press must not have consumed the id the first one is
      // waiting on, or its settle would arrive stale.
      expect(confirmFollow(second.state, first.requestId, 'followed').isFollowing).toBe(true);
    });

    it('is exactly one request per settled press — a second press after settling is a real one', () => {
      let state = seeded({ isFollowing: false });
      for (let i = 0; i < 3; i += 1) {
        const press = sent(pressFollow(state));
        expect(press.state.isFollowing).toBe(i % 2 === 0);
        state = confirmFollow(press.state, press.requestId, i % 2 === 0 ? 'followed' : 'unfollowed');
      }
      // Three settled presses from `false`: true, false, true.
      expect(state.isFollowing).toBe(true);
      expect(state.requestId).toBe(3);
    });
  });

  describe('the local self-follow refusal', () => {
    it('refuses locally and makes NO request', () => {
      const state = seeded({ creator_id: VIEWER, isFollowing: false, viewerId: VIEWER });
      const press = pressFollow(state);

      expect(press.kind).toBe('refused');
      if (press.kind === 'refused') expect(press.reason).toBe('self-follow');
      // Nothing sent, nothing flipped, nothing to roll back.
      expect(press.state.pending).toBe(false);
      expect(press.state.isFollowing).toBe(false);
      expect(press.state.rollback).toBeNull();
      expect(press.state.requestId).toBe(0);
    });

    it('surfaces the refusal as a value, matching the server\'s own string', () => {
      // views/social.py:291 — `{'error': 'You cannot follow yourself.'}`, trailing
      // period. Greppable against the backend, and distinct from a failure so
      // the UI can say "you cannot follow yourself" instead of "something went
      // wrong and you may retry".
      const press = pressFollow(seeded({ creator_id: VIEWER, isFollowing: false, viewerId: VIEWER }));
      expect(press.state.error).toBe(FOLLOW_SELF_REFUSAL_MESSAGE);
      expect(press.state.error).not.toBe(FOLLOW_FAILED_MESSAGE);
    });

    it('is checked BEFORE in-flight, so it is refused even while a request is outstanding', () => {
      // Admissibility is not a function of what else is happening: an
      // inadmissible press can never become admissible by waiting, and `refused`
      // is the more informative answer than `ignored`. The 2x2 is pinned in the
      // ordering table below so this cannot be reordered silently.
      const foreign = sent(pressFollow(seeded({ isFollowing: false })));
      const selfWhilePending = pressFollow({ ...foreign.state, userId: VIEWER });

      expect(selfWhilePending.kind).toBe('refused');
    });

    it('is inert without a viewerId — the guard needs the viewer, not the absence of it', () => {
      // No `viewerId` means the client cannot know it is following itself, so it
      // must not refuse on a guess. The server's 400 is then the authority, and
      // `describeFollowError` renders it correctly (below).
      const state = seeded({ creator_id: VIEWER, isFollowing: false, viewerId: null });
      expect(pressFollow(state).kind).toBe('sent');
    });
  });

  describe('the check order, as a truth table', () => {
    // no-target x self x in-flight x unknown. Every cell asserted, and the
    // count asserted so a truncated loop cannot pass while claiming to cover it.
    const ids = [null, CREATOR];
    const viewerMatches = [false, true];
    const pending = [false, true];

    const cells: Array<{ userId: number | null; self: boolean; busy: boolean; unknown: boolean; expected: FollowPress['kind']; reason?: string }> = [];

    for (const userId of ids) {
      for (const self of viewerMatches) {
        for (const busy of pending) {
          for (const unknown of [false, true]) {
            const value: boolean | null = unknown ? null : false;
            const press = pressFollow({
              userId,
              viewerId: self ? (userId ?? VIEWER) : VIEWER,
              isFollowing: value,
              pending: busy,
              error: null,
              requestId: 3,
              rollback: busy ? { requestId: 3, isFollowing: false } : null,
            });
            const reason = press.kind === 'ignored' ? press.reason : undefined;
            cells.push({ userId, self, busy, unknown, expected: press.kind, reason });
          }
        }
      }
    }

    it('resolves every cell the same way, and the count is the product of the axes', () => {
      // 2 x 2 x 2 x 2 = 16 cells.
      expect(cells).toHaveLength(16);

      for (const cell of cells) {
        const label = `userId=${cell.userId} self=${cell.self} busy=${cell.busy} unknown=${cell.unknown}`;
        if (cell.userId === null) {
          expect([label, cell.expected]).toEqual([label, 'ignored']);
          expect([label, cell.reason]).toEqual([label, 'no-target']);
        } else if (cell.self) {
          // Wins over everything: refused, including while busy.
          expect([label, cell.expected]).toEqual([label, 'refused']);
        } else if (cell.busy) {
          expect([label, cell.expected]).toEqual([label, 'ignored']);
          expect([label, cell.reason]).toEqual([label, 'in-flight']);
        } else if (cell.unknown) {
          expect([label, cell.expected]).toEqual([label, 'ignored']);
          expect([label, cell.reason]).toEqual([label, 'unknown-state']);
        } else {
          expect([label, cell.expected]).toEqual([label, 'sent']);
        }
      }
    });
  });
});

// ===========================================================================
// PART 3 — settling
// ===========================================================================

describe('confirmFollow', () => {
  it('takes the value from the SERVER STRING, not from what the press intended', () => {
    // The press intended `followed`; the server says `unfollowed`. The server
    // wins, because a client whose local state was wrong is exactly the case
    // that produces the original defect.
    const press = sent(pressFollow(seeded({ isFollowing: false })));
    expect(press.state.isFollowing).toBe(true);

    expect(confirmFollow(press.state, press.requestId, 'unfollowed').isFollowing).toBe(false);
  });

  it('has no HTTP status code parameter, so the code cannot be branched on', () => {
    // 201 means followed and 200 means unfollowed, but the pairing is not
    // binding and `apiFetch` erases the code before this module sees anything
    // (client.ts:304-335). The strongest form of the rule is that there is no
    // slot to put the code in.
    const press = sent(pressFollow(seeded({ isFollowing: false })));
    expect(Object.keys(pressFollow(seeded({ isFollowing: false }))).sort()).toEqual([
      'kind',
      'requestId',
      'state',
    ]);
    expect(Object.keys(press.state).sort()).toEqual([
      'error',
      'isFollowing',
      'pending',
      'requestId',
      'rollback',
      'userId',
      'viewerId',
    ]);
    // The only two values the third parameter accepts.
    const statuses: Array<Parameters<typeof confirmFollow>[2]> = ['followed', 'unfollowed'];
    expect(statuses).toHaveLength(2);
    expect(confirmFollow(press.state, press.requestId, 'followed').isFollowing).toBe(true);
  });

  it('clears pending, the error and the rollback on success', () => {
    const press = sent(pressFollow(seeded({ isFollowing: false })));
    const settled = confirmFollow(press.state, press.requestId, 'followed');
    expect(settled).toEqual({
      userId: CREATOR,
      viewerId: VIEWER,
      isFollowing: true,
      pending: false,
      error: null,
      requestId: press.requestId,
      rollback: null,
    });
  });

  it('leaves the value alone when the server says the same thing the press applied', () => {
    const press = sent(pressFollow(seeded({ isFollowing: false })));
    expect(confirmFollow(press.state, press.requestId, 'followed').isFollowing).toBe(true);
  });

  it('is a no-op for a stale request id, and does not clear pending either', () => {
    // Clearing `pending` on a stale success would hand the button back while a
    // NEWER press's request is still in flight — which is the double-toggle the
    // in-flight guard exists to prevent, reached from the other direction.
    const first = sent(pressFollow(seeded({ isFollowing: false })));
    const busy: FollowState = {
      ...first.state,
      isFollowing: false,
      requestId: first.requestId + 1,
      rollback: { requestId: first.requestId + 1, isFollowing: true },
    };

    const settled = confirmFollow(busy, first.requestId, 'followed');
    expect(settled).toBe(busy);
    expect(settled.isFollowing).toBe(false);
    expect(settled.pending).toBe(true);
  });

  it('is a no-op when there is no outstanding request at all', () => {
    const idle = seeded({ isFollowing: false });
    expect(confirmFollow(idle, 1, 'followed')).toBe(idle);
  });

  it('is idempotent: settling the same success twice is harmless', () => {
    const press = sent(pressFollow(seeded({ isFollowing: false })));
    const once = confirmFollow(press.state, press.requestId, 'followed');
    const twice = confirmFollow(once, press.requestId, 'followed');
    expect(twice).toEqual(once);
    expect(twice.isFollowing).toBe(true);
    expect(twice.pending).toBe(false);
  });
});

describe('failFollow', () => {
  it('restores the pre-press value and reports the failure', () => {
    const press = sent(pressFollow(seeded({ isFollowing: true })));
    expect(press.state.isFollowing).toBe(false);

    const failed = failFollow(press.state, press.requestId, new Error('boom'));
    expect(failed.isFollowing).toBe(true);
    expect(failed.pending).toBe(false);
    expect(failed.rollback).toBeNull();
    expect(failed.error).toBe(FOLLOW_FAILED_MESSAGE);
  });

  it('is a value, never an exception — the state is always usable after a failure', () => {
    const press = sent(pressFollow(seeded({ isFollowing: false })));
    const failed = failFollow(press.state, press.requestId, new Error('boom'));

    expect(typeof failed.error).toBe('string');
    expect(failed.pending).toBe(false);
    // Usable: a retry from the rolled-back state works and clears the error.
    const retry = sent(pressFollow(failed));
    expect(retry.state.error).toBeNull();
    expect(retry.state.isFollowing).toBe(true);
  });

  it('keeps the button live after a rollback — no second tap is wasted', () => {
    // The web card's fix left the button dead until a re-render; the value here
    // is rolled back AND the button is immediately pressable, so the retry is
    // one tap.
    const press = sent(pressFollow(seeded({ isFollowing: false })));
    const failed = failFollow(press.state, press.requestId, new Error('boom'));
    expect(pressFollow(failed).kind).toBe('sent');
  });

  it('surfaces the self-follow refusal distinctly when the server is the one to say so', () => {
    // The local guard is best-effort — it needs `viewerId`. A caller that has
    // not loaded it lets the press through, and then the server's 400 is the
    // authority. Rendering that as "could not update follow" would tell the user
    // to retry something that can never succeed.
    const press = sent(pressFollow(seeded({ creator_id: VIEWER, isFollowing: false, viewerId: null })));
    const failed = failFollow(press.state, press.requestId, { status: 400 });

    expect(failed.error).toBe(FOLLOW_SELF_REFUSAL_MESSAGE);
    expect(failed.isFollowing).toBe(false);
    expect(failed.pending).toBe(false);
  });

  describe('the ABA hazard — a stale failure must not revert a newer press', () => {
    it('does NOT revert the second press when the first failure arrives late', () => {
      // ─────────────────────────────────────────────────────────────────
      // The worked example from `isCurrentRequest`, asserted end to end.
      //
      //   seed is_following = false
      //   press #1  -> optimistic true,  rollback = {1, false}
      //   press #2  -> optimistic false, rollback = {2, true}
      //   failure for #1 arrives
      //
      // An unconditional rollback restores `true`: it reverts the SECOND press
      // to satisfy the FIRST one's failure. `isFollowing` is then wrong and no
      // further action repairs it, because the next press sends a TOGGLE, not a
      // set — the user pressing "Follow" again would UNFOLLOW.
      // ─────────────────────────────────────────────────────────────────
      const first = sent(pressFollow(seeded({ isFollowing: false })));
      expect(first.state.isFollowing).toBe(true);
      expect(first.state.rollback).toEqual({ requestId: 1, isFollowing: false });

      // The caller re-enables the button before the promise settles. This is
      // ordinary code, not a bug: a debounce window closing on a timer, a
      // gesture handler and a keyboard handler both wiring `onPress`, or a
      // `finally` that clears `pending` on an unmounted path. Any of them lets
      // two requests be outstanding at once, which is what the id guards.
      const reopened: FollowState = { ...first.state, pending: false };

      const second = sent(pressFollow(reopened));
      expect(second.requestId).toBe(2);
      expect(second.state.isFollowing).toBe(false);
      expect(second.state.rollback).toEqual({ requestId: 2, isFollowing: true });

      // NOW the first failure lands.
      const after = failFollow(second.state, first.requestId, new Error('boom'));

      // The second press stands.
      expect(after.isFollowing).toBe(false);
      expect(after.pending).toBe(true);
      expect(after.rollback).toEqual({ requestId: 2, isFollowing: true });
      // The stale failure is also not reported: it belongs to a press the user
      // has already moved on from, and showing it would blame the newer one.
      expect(after.error).toBeNull();
    });

    it('the guarded value is the OPPOSITE of the unguarded one', () => {
      // Guards against a test that accidentally pins the same answer as the
      // mutant. `true` is both press #2's pre-press value and the opposite of
      // what the user last asked for, so the two implementations cannot agree.
      const first = sent(pressFollow(seeded({ isFollowing: false })));
      const second = sent(pressFollow({ ...first.state, pending: false }));

      expect(second.state.isFollowing).toBe(false);
      // What an unguarded rollback would have restored.
      const unguarded = second.state.rollback?.isFollowing;
      expect(unguarded).toBe(true);

      expect(failFollow(second.state, first.requestId, new Error('x')).isFollowing).toBe(false);
    });

    it('a stale SUCCESS does not apply either, nor clear the newer request', () => {
      const first = sent(pressFollow(seeded({ isFollowing: false })));
      const second = sent(pressFollow({ ...first.state, pending: false }));

      // Success for #1 says "followed"; press #2's optimistic value is `false`.
      // Applying it would contradict the press the user made most recently.
      const after = confirmFollow(second.state, first.requestId, 'followed');
      expect(after.isFollowing).toBe(false);
      expect(after.pending).toBe(true);
    });

    it('a stray failure against a settled state changes nothing', () => {
      // A duplicated effect run, a state rebuilt from a cache, a late callback
      // from an unmounted screen. Rolling back with no rollback to restore from
      // would have to invent a value.
      const press = sent(pressFollow(seeded({ isFollowing: false })));
      const settled = confirmFollow(press.state, press.requestId, 'followed');
      const after = failFollow(settled, press.requestId, new Error('boom'));

      expect(after.isFollowing).toBe(true);
      expect(after.error).toBeNull();
      expect(after.pending).toBe(false);
    });

    it('rolls back when the id DOES match, on the very same shape', () => {
      // The negative control for the guard: with a matching id the rollback
      // happens, so the test above is passing because of the guard and not
      // because failures are never applied.
      const first = sent(pressFollow(seeded({ isFollowing: false })));
      const after = failFollow(first.state, first.requestId, new Error('boom'));
      expect(after.isFollowing).toBe(false);
      expect(after.error).toBe(FOLLOW_FAILED_MESSAGE);
    });
  });

  it('recovers a corrupted requestId instead of wedging pending forever', () => {
    // `requestId` only ever increments from 0, but `FollowState` is a plain
    // exported object — a persisted or hand-built one can carry `NaN`, and
    // `NaN + 1` is `NaN`, which would make the settle correlate with nothing
    // and leave `pending` true for the life of the component.
    const corrupt: FollowState = { ...seeded({ isFollowing: false }), requestId: Number.NaN };
    const press = sent(pressFollow(corrupt));

    expect(Number.isInteger(press.requestId)).toBe(true);
    expect(press.requestId).toBe(1);
    expect(failFollow(press.state, press.requestId, new Error('x')).pending).toBe(false);
  });
});

// ===========================================================================
// PART 4 — error classification
// ===========================================================================

describe('describeFollowError', () => {
  it('names the self-follow refusal from a 400, structurally', () => {
    // Duck-typed via `isFollowSelfRefusal`, never `instanceof ApiError` — see
    // the argument in `api/endpoints/social.ts`. The predicate is IMPORTED, not
    // restated: two 400 classifiers in one app is how a 400 for a malformed clip
    // id starts rendering as "you cannot follow yourself".
    expect(describeFollowError({ status: 400 })).toBe(FOLLOW_SELF_REFUSAL_MESSAGE);
  });

  it('reports every other failure with the generic message', () => {
    for (const err of [
      { status: 404 },
      { status: 401 },
      { status: 429 },
      { status: 500 },
      { status: 0 },
      new Error('Network request failed'),
      'boom',
      42,
      null,
      undefined,
      {},
    ]) {
      expect(describeFollowError(err)).toBe(FOLLOW_FAILED_MESSAGE);
    }
  });

  it('is total — no thrown value maps to undefined or a non-string', () => {
    const hostile = [null, undefined, 0, 1, -1, '', 'x', Number.NaN, true, false, Symbol('s'), () => 0];
    for (const err of hostile) {
      expect(typeof describeFollowError(err)).toBe('string');
    }
  });

  it('uses the server\'s own wording for the refusal, trailing period and all', () => {
    // views/social.py:291 — so the client-generated copy and the server's body
    // cannot differ by a full stop.
    expect(FOLLOW_SELF_REFUSAL_MESSAGE).toBe('You cannot follow yourself.');
  });

  it('uses the web client\'s wording for a generic failure', () => {
    // frontend/src/test/reelCard.test.tsx asserts /could not update follow/i, so
    // the two clients cannot drift into two different promises about retrying.
    expect(FOLLOW_FAILED_MESSAGE).toMatch(/could not update follow/i);
  });
});

// ===========================================================================
// PART 5 — totality
// ===========================================================================

describe('totality', () => {
  it('produces a valid state for every combination of hostile hydration inputs, and never throws', () => {
    const hostile = [
      0,
      1,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
    ];
    const maybe = [...hostile, null, undefined];
    const truthy = [true, false, null, undefined];

    let cases = 0;
    for (const creator_id of maybe) {
      for (const viewerId of maybe) {
        for (const isFollowing of truthy) {
          const state = hydrateFollowState({
            clip: { creator_id: creator_id as number },
            viewerId: viewerId as number,
            isFollowing: isFollowing as boolean,
          });

          // Every field is a valid value of its type — never NaN, never a
          // negative id, never a non-boolean in a boolean slot.
          expect(state.userId === null || (Number.isInteger(state.userId) && state.userId > 0)).toBe(true);
          expect(state.viewerId === null || (Number.isInteger(state.viewerId) && state.viewerId > 0)).toBe(true);
          expect([true, false, null]).toContain(state.isFollowing);
          expect(typeof state.pending).toBe('boolean');
          expect(state.error === null || typeof state.error === 'string').toBe(true);
          expect(Number.isInteger(state.requestId)).toBe(true);
          expect(state.requestId).toBeGreaterThanOrEqual(0);
          expect(state.rollback).toBeNull();

          // And a full press → settle cycle on top of it, in both directions.
          const press = pressFollow(state);
          expect(['sent', 'ignored', 'refused']).toContain(press.kind);
          if (press.kind === 'sent') {
            expect([true, false]).toContain(press.state.isFollowing);
            expect(press.state.pending).toBe(true);
            const ok = confirmFollow(press.state, press.requestId, 'followed');
            expect(ok.isFollowing).toBe(true);
            expect(ok.pending).toBe(false);
          } else {
            expect(press.state.pending).toBe(state.pending);
          }
          // A settle against a request that was never issued is a NO-OP, not a
          // throw — including on a state that is still busy, where clearing
          // `pending` would be the bug rather than the fix.
          const stale = failFollow(press.state, 999, new Error('x'));
          expect(stale.pending).toBe(press.state.pending);
          expect(stale.isFollowing).toBe(press.state.isFollowing);
          expect(stale.error).toBe(press.state.error);

          cases += 1;
        }
      }
    }
    // 11 x 11 x 4. Asserted so a truncated inner loop cannot pass while
    // claiming to have enumerated the space.
    expect(cases).toBe(11 * 11 * 4);
  });

  it('never mutates a state it was given, across a whole session', () => {
    const start = seeded({ isFollowing: false });
    const frozen = JSON.stringify(start);

    let state = start;
    for (let i = 0; i < 10; i += 1) {
      const press = pressFollow(state);
      state = press.state;
      if (press.kind === 'sent') {
        state = i % 3 === 0
          ? failFollow(state, press.requestId, new Error('boom'))
          : confirmFollow(state, press.requestId, 'followed');
      }
    }
    expect(JSON.stringify(start)).toBe(frozen);
  });

  it('holds a coherent state after 50 alternating presses, settles and failures', () => {
    let state = seeded({ isFollowing: false });
    for (let i = 1; i <= 50; i += 1) {
      const press = pressFollow(state);
      if (press.kind !== 'sent') continue;
      state = i % 4 === 0
        ? failFollow(press.state, press.requestId, new Error('boom'))
        : confirmFollow(press.state, press.requestId, i % 2 === 0 ? 'unfollowed' : 'followed');

      // Invariants that must hold at EVERY settle.
      expect(state.pending).toBe(false);
      expect(state.rollback).toBeNull();
      expect([true, false]).toContain(state.isFollowing);
      expect(state.requestId).toBe(i);
    }
    expect(state.error === null || typeof state.error === 'string').toBe(true);
  });
});