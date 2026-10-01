/**
 * ActionCluster — the reel's like / comments / share column.
 *
 * ## What is real and what is doubled
 *
 * `../../api/endpoints/interactions` is mocked at the module boundary and
 * NOTHING else. The component under test is the shipped one: press → guard →
 * optimistic write → `toggleLike` → reconcile from `res.status` → rollback on
 * rejection. Assertions land on the mocked `toggleLike` and on the rendered
 * tree, never on a spy of a component's internals.
 *
 * ## NO `jest.mock('expo-audio')` IN THIS FILE, AND THAT IS NOT AN OMISSION
 * `ClipTransport.test.tsx:87-90` and `ReelCard.test.tsx:76-79` both mock it, and
 * this file was written to that convention first. It does not need to:
 * `ActionCluster` imports no module whose graph reaches the native player. Its
 * imports are `react-native`, `lucide-react-native`, `../../design/*`,
 * `../ui/primitives` and `../../api/endpoints/interactions` — and that last one
 * reaches only `../client` (expo-constants) and `./schema` (zod). Nothing
 * imports `src/store/player.ts`, the only thing in the reel tree that imports
 * `expo-audio`.
 *
 * The consequence is the point: this suite needs no native double, so a failure
 * here is a failure in the component. `lib/interactionGuard.ts:121-126` states
 * the same trade from the other side — a suite whose premise is "no native
 * doubles" cannot import a module that drags one in. A mock for a module that is
 * not in the import graph would be cargo cult that also hides the day someone
 * DOES add the store to this component.
 *
 * ## `lucide-react-native` is imported NORMALLY
 * `jest.config.js` allowlists it in `transformIgnorePatterns` and adds the
 * `.mjs` transform. The per-suite `jest.mock` bridge that used to exist in
 * `ClipTransport.test.tsx` (reaching `dist/cjs/*` through an absolute
 * `__dirname` path) is deliberately not reintroduced: it was a test-only channel
 * into a package the app itself imports normally.
 *
 * ## The icons are asserted by their PATH, and their STATE off the Svg node
 * `react-native-svg` does not forward a `testID` to the native view, so there is
 * no testID to query and no component name to check. Reading the `d` attribute
 * is the only way to see which glyph rendered, and it pins the SHAPE rather than
 * the name of a component (`ClipTransport.test.tsx:32-40` is the reference).
 *
 * The liked/unliked channels are read off the `RNSVGSvgView` host node rather
 * than off the `RNSVGPath`, and that is measured, not assumed: a probe of
 * `lucide-react-native@1.48.0` under this jest config shows
 *
 *     RNSVGSvgView  fill="#690005"  stroke="#690005"  strokeWidth=2  w/h=22
 *     RNSVGGroup   fill=[object]    stroke=[object]   (processed colours)
 *     RNSVGPath    d="M2 9.5a5.5…"
 *
 * — the `fill`/`color` I pass land as raw values on the Svg, and the children
 * receive PROCESSED colour objects. So `fill` and `stroke` are read from the Svg
 * (`svgUnder`) and `d` from the path (`pathsUnder`), and no assertion here
 * depends on a prop that turns into an opaque object.
 *
 * ## TIMERS
 * None. Nothing here animates, so there are no fake timers, and every style
 * read is a STATIC one — `StyleSheet.flatten` on the resolved `props.style`,
 * which is legitimate precisely because no reanimated value is involved. For an
 * animated property the same read is frozen at its mount-time value and the
 * assertion is a false pass (`reanimatedHarness.test.tsx` is the reference).
 *
 * ## RNTL v14
 * `render` is async, so every query lives on the awaited value; element-level
 * `find`/`findAll` are GONE, so subtrees are reached with `queryAll` off an
 * instance the standard queries returned; and the count `<Text>`s are
 * `aria-hidden` (the button's name already carries the number), so their queries
 * need `includeHiddenElements` — which is the COMPONENT being right, not the
 * test working around it. Same convention as `ReelCard.test.tsx:155-160`.
 *
 * ## THE IN-FLIGHT GUARD HAS TWO ENFORCEMENT POINTS AND ONLY ONE IS REACHABLE
 * RNTL gates a press on the host's own `onStartShouldSetResponder()`, which
 * `Pressability` derives from `disabled` — so once the like button is disabled
 * by the pending state, a `fireEvent` at it is swallowed by the HARNESS. An
 * integration test can therefore observe the PAIR and never either half: remove
 * only the button's `disabled` and the handler guard still holds (green); remove
 * only the handler guard and the responder still holds (green).
 *
 * That is why the gates are EXPORTED TOTAL FUNCTIONS (`canToggleLike`,
 * `canOpenComments`, `canOpenShare`) rather than inline conditions. The
 * `canSkipClip` discipline (`ClipTransport.tsx:146-195`): the rule lives in a
 * function, the function is asserted directly over its whole input space, and
 * the component consults it in both places so the two cannot drift. An
 * integration test for the pair plus a unit test for each gate means either
 * half's removal is a failure rather than a silent no-op.
 *
 * ## THE MID-FLIGHT WINDOW IS NOT OBSERVABLE HERE, AND THAT IS MEASURED
 * The optimistic window — the rendered tree between the press and the response —
 * is the one property of this component no test in this file can assert. The
 * reason is not "it was hard to reach"; it is that every route to it is broken,
 * and each was measured on this repo rather than assumed:
 *
 *  1. `await fireEvent.press(...)` does NOT return while the handler awaits an
 *     unsettled promise. React 19's `act` resolves its thenable only after
 *     `recursivelyFlushAsyncActWork` empties `actQueue`
 *     (`react/cjs/react.development.js:561-583`), and RNTL awaits that thenable
 *     (`dist/fire-event.js:92`). Measured: a handler awaiting a promise that
 *     never settles hangs the press until the test times out.
 *  2. `await act(async () => { handler(); })` hangs identically, so bypassing
 *     `fireEvent` buys nothing.
 *  3. `jest.useFakeTimers()` does not help. The drain runs on
 *     `MessageChannel.postMessage` (`enqueueTask`, `react.development.js:530-545`),
 *     which fake timers do not own. Measured with a promise that settles only on
 *     a fake timer the test never advances: still hangs.
 *  4. Starting the press without awaiting it and flushing with a second `act`
 *     DOES return the optimistic state — and POISONS EVERY LATER TEST IN THE
 *     FILE. React logs "You seem to have overlapping act() calls, this is not
 *     supported"; the next `render` then produces an empty tree and 50 unrelated
 *     assertions fail. Measured, then reverted.
 *
 * So the optimism is asserted where it IS observable, and the gap is stated
 * rather than papered over:
 *  - `optimisticLike` is a pure function, so the ARITHMETIC and the PAIRING of
 *    the two writes are asserted over their whole input space.
 *  - the OBSERVABLE consequence of the write surviving — the local count, with
 *    no server count anywhere in the response — is asserted on the settled
 *    success path.
 *  - what is NOT asserted anywhere is the ORDER, i.e. that the write precedes
 *    the response. Closing that needs a device check or an e2e harness, and
 *    `ActionCluster.tsx`'s `onToggleLike` says so at the write site.
 *
 * This is the same shape as `ClipTransport.test.tsx:886-895`, which documents
 * that a coordinate-level tap test is not feasible because the test renderer
 * runs no layout engine, and then asserts what IS reachable.
 *
 * ## WHY FAILURES ARE `mockRejectedValue` AND NOT A PRE-BUILT REJECTED PROMISE
 * `mockReturnValue(Promise.reject(...))` builds the rejected promise at mock-setup
 * time. If the `await renderCluster()` that follows yields first — which it does,
 * it is an await — Node has no handler attached yet and reports an unhandled
 * rejection, which jest then attributes to whatever test is running. That is
 * what produced a 5 s timeout on five tests in the first draft of this file, all
 * of them innocent. `mockRejectedValue` defers the rejection to CALL time, so the
 * component attaches its handler in the same tick.
 */

import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import type { TestInstance } from 'test-renderer';

import {
  ACTION_BUTTON_SIZE,
  ACTION_CLUSTER_GAP,
  ACTION_ICON_SIZE,
  ActionCluster,
  LIKED_GLYPH_SCALE,
  LIKE_ERROR_COPY,
  canOpenComments,
  canOpenShare,
  canToggleLike,
  nextLikeCount,
  optimisticLike,
  type ActionClusterProps,
} from '../ActionCluster';
import { toggleLike } from '../../../api/endpoints/interactions';
import { MIN_TOUCH_TARGET } from '../../ui/primitives';
import {
  accessibility,
  brand,
  content,
  glass,
  radius,
  spacing,
  status,
} from '../../../design/tokens';
import { typography } from '../../../design/typography';

jest.mock('../../../api/endpoints/interactions', () => ({
  toggleLike: jest.fn(),
}));

const mockToggleLike = toggleLike as jest.MockedFunction<typeof toggleLike>;

/* ------------------------------------------------------------------ */
/* Constants read off the installed lucide build                      */
/* ------------------------------------------------------------------ */

/** `lucide-react-native@1.48.0` `dist/cjs/icons/heart.js` — the one path. */
const HEART_PATHS = [
  'M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5',
];
/** `dist/cjs/icons/message-circle.js` — the one path. */
const MESSAGE_CIRCLE_PATHS = [
  'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719',
];

const CLIP = 'clip-a';
const LIKES = 12;
const COMMENTS = 3;

const ROOT = 'action-cluster';
const LIKE = 'action-like';
const COMMENT = 'action-comment';
const SHARE = 'action-share';
const ERROR = 'action-like-error';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

type Rendered = Awaited<ReturnType<typeof render>>;

/** Hidden-aware lookup: the count `<Text>`s are `aria-hidden` by design. */
const node = (r: Rendered, testID: string): TestInstance =>
  r.getByTestId(testID, { includeHiddenElements: true });

const queryNode = (r: Rendered, testID: string): TestInstance | null =>
  r.queryByTestId(testID, { includeHiddenElements: true });

/**
 * A STATIC style. Nothing here is animated, so `props.style` is not frozen —
 * and a `Pressable`'s function style is resolved with `pressed: false`, so the
 * press transform is excluded from the flattened result.
 */
function styleOf(n: TestInstance): Record<string, unknown> {
  const raw = n.props.style;
  const resolved =
    typeof raw === 'function'
      ? (raw as (state: { pressed: boolean }) => unknown)({ pressed: false })
      : raw;
  return (StyleSheet.flatten(resolved as never) ?? {}) as Record<string, unknown>;
}

/** Every `d` attribute under a control, in render order. */
function pathsUnder(control: TestInstance): string[] {
  return control
    .queryAll((n) => typeof n.props?.d === 'string')
    .map((n) => String(n.props.d));
}

/** The single `RNSVGSvgView` host node under a control. */
function svgUnder(control: TestInstance): TestInstance {
  const matches = control.queryAll((n) => String(n.type).includes('Svg'));
  expect(matches).toHaveLength(1);
  return matches[0] as TestInstance;
}

/** `fill` / `stroke` land RAW on the Svg node; the children get objects. */
const glyphProps = (control: TestInstance): Record<string, unknown> =>
  svgUnder(control).props as Record<string, unknown>;

/** The glyph wrapper's scale — the second non-colour channel. */
function glyphScale(control: TestInstance): number | undefined {
  const matches = control.queryAll((n) => {
    const t = styleOf(n).transform as Array<{ scale?: number }> | undefined;
    return typeof t?.[0]?.scale === 'number';
  });
  expect(matches).toHaveLength(1);
  const t = styleOf(matches[0] as TestInstance).transform as Array<{ scale: number }>;
  return t[0]?.scale;
}

/** The number rendered under a control, or `null` when it renders none. */
const shownCount = (r: Rendered, control: string): string | null => {
  const n = queryNode(r, `${control}-count`);
  return n ? String(n.props.children) : null;
};

const labelOf = (r: Rendered, control: string): unknown =>
  node(r, control).props.accessibilityLabel;

const baseProps = (over: Partial<ActionClusterProps> = {}): ActionClusterProps => ({
  clipId: CLIP,
  isLiked: false,
  likeCount: LIKES,
  commentCount: COMMENTS,
  isShareable: true,
  disabled: false,
  onOpenComments: jest.fn(),
  onOpenShare: jest.fn(),
  ...over,
});

const renderCluster = (over: Partial<ActionClusterProps> = {}) =>
  render(<ActionCluster {...baseProps(over)} />);

/** Flush a settled `toggleLike` and the state updates around it. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

type LikeResult = Awaited<ReturnType<typeof toggleLike>>;

beforeEach(() => {
  mockToggleLike.mockReset();
  mockToggleLike.mockResolvedValue({ status: 'liked' });
});

/* ------------------------------------------------------------------ */
/* The three controls                                                  */
/* ------------------------------------------------------------------ */

describe('ActionCluster', () => {
  describe('the three controls', () => {
    it('renders like, comments and share, each a labelled button', async () => {
      const r = await renderCluster();

      expect(labelOf(r, LIKE)).toBe(`Like, ${LIKES} likes`);
      expect(labelOf(r, COMMENT)).toBe(`Comments, ${COMMENTS} comments`);
      expect(labelOf(r, SHARE)).toBe('Share');

      for (const id of [LIKE, COMMENT, SHARE]) {
        const b = node(r, id);
        expect({ id, role: b.props.accessibilityRole }).toEqual({ id, role: 'button' });
        expect(b.props.accessible).not.toBe(false);
        expect(typeof b.props.accessibilityLabel).toBe('string');
        expect((b.props.accessibilityLabel as string).length).toBeGreaterThan(0);
      }
    });

    it('orders them like, comment, share, top to bottom', async () => {
      // The source's column order (`:259` like, `:276` comments, `:290` share).
      // Render order is the only handle on this in a renderer with no layout
      // engine. `TestInstance` has no `findAll` in RNTL v14, so the subtree is
      // reached with `queryAll` off an instance a standard query returned — the
      // `ClipTransport.pathsUnder` pattern.
      const r = await renderCluster();
      const order = node(r, ROOT)
        .queryAll((n) => [LIKE, COMMENT, SHARE].includes(String(n.props?.testID)))
        .map((n) => String(n.props.testID));
      expect(order).toEqual([LIKE, COMMENT, SHARE]);
    });

    it('shows the like, comment and share counts, and a share count when given', async () => {
      const r = await renderCluster({ shareCount: 7 });
      expect(shownCount(r, LIKE)).toBe(String(LIKES));
      expect(shownCount(r, COMMENT)).toBe(String(COMMENTS));
      expect(shownCount(r, SHARE)).toBe('7');
      expect(labelOf(r, SHARE)).toBe('Share, 7 shares');
    });

    it('renders the share glyph with NO count when none is supplied', async () => {
      // `shareCount` is optional, so the button must not read "undefined shares".
      const r = await renderCluster();
      expect(shownCount(r, SHARE)).toBeNull();
      expect(labelOf(r, SHARE)).toBe('Share');
      expect(String(labelOf(r, SHARE))).not.toContain('undefined');
    });

    it('draws the real heart and message glyphs, at 22px', async () => {
      const r = await renderCluster();
      expect(pathsUnder(node(r, LIKE))).toEqual(HEART_PATHS);
      expect(pathsUnder(node(r, COMMENT))).toEqual(MESSAGE_CIRCLE_PATHS);
      expect(ACTION_ICON_SIZE).toBe(22);
      for (const id of [LIKE, COMMENT]) {
        const svg = glyphProps(node(r, id));
        expect({ id, width: svg.width, height: svg.height }).toEqual({
          id,
          width: ACTION_ICON_SIZE,
          height: ACTION_ICON_SIZE,
        });
      }
      // The share glyph is three circles and two lines, so it has no `d` at all —
      // which is why "every icon has path data" is not a universal assertion.
      expect(node(r, SHARE).queryAll((n) => String(n.type).includes('Circle'))).toHaveLength(3);
      expect(node(r, SHARE).queryAll((n) => String(n.type).includes('Line'))).toHaveLength(2);
    });

    it('is `box-none`, so the gaps between the circles are not a dead zone', async () => {
      // `auto` makes the column itself the hit test wherever the point lands, so
      // the 24px gaps and the width beside the circles would swallow taps aimed
      // past them — the reason `ClipTransport`'s root carries the same prop.
      const r = await renderCluster();
      expect(node(r, ROOT).props.pointerEvents).toBe('box-none');
    });
  });

  /* ---------------------------------------------------------------- */
  /* The gates, on their own                                            */
  /* ---------------------------------------------------------------- */

  /**
   * WHY THESE ARE SEPARATE `it`s AND NOT ONLY AN INTEGRATION CLAIM.
   *
   * Each gate has TWO enforcement points — the `Pressable`'s `disabled` and a
   * guard in the handler — and RNTL will not deliver a `fireEvent` to a disabled
   * control. An integration test can therefore observe the pair and neither
   * half: deleting the button's `disabled` leaves the handler guard holding
   * (green), and deleting the handler guard leaves the responder holding
   * (green). These are what close that gap, over the whole input space rather
   * than through a handful of renders.
   */
  describe('the gates, on their own', () => {
    it('canToggleLike refuses while a request is outstanding, and nothing else', () => {
      expect(canToggleLike({ disabled: false, pending: false })).toBe(true);
      // Each reason in isolation, so neither can be dropped unnoticed.
      expect(canToggleLike({ disabled: true, pending: false })).toBe(false);
      expect(canToggleLike({ disabled: false, pending: true })).toBe(false);
      expect(canToggleLike({ disabled: true, pending: true })).toBe(false);
    });

    it('canOpenComments is NOT closed by a pending like', () => {
      // A slow like must not lock the reel's comments: unrelated requests, and
      // only one of them is outstanding. `canToggleLike` and `canOpenComments`
      // are separate functions precisely so this asymmetry is expressible.
      expect(canOpenComments({ disabled: false })).toBe(true);
      expect(canOpenComments({ disabled: true })).toBe(false);
    });

    it('canOpenShare is closed by `disabled` OR by an unshareable clip', () => {
      expect(canOpenShare({ disabled: false, isShareable: true })).toBe(true);
      expect(canOpenShare({ disabled: true, isShareable: true })).toBe(false);
      expect(canOpenShare({ disabled: false, isShareable: false })).toBe(false);
      expect(canOpenShare({ disabled: true, isShareable: false })).toBe(false);
    });

    it('cover the whole 2x2x2 input space, so a new condition cannot hide', () => {
      const seen: string[] = [];
      for (const disabled of [true, false]) {
        for (const pending of [true, false]) {
          for (const isShareable of [true, false]) {
            const gate = { disabled, pending, isShareable };
            expect({
              ...gate,
              like: canToggleLike(gate),
              comments: canOpenComments(gate),
              share: canOpenShare(gate),
            }).toEqual({
              disabled,
              pending,
              isShareable,
              // `like` is the only one that consults `pending`.
              like: !disabled && !pending,
              comments: !disabled,
              share: !disabled && isShareable,
            });
            seen.push(`${disabled ? 'D' : '-'}${pending ? 'P' : '-'}${isShareable ? 'S' : '-'}`);
          }
        }
      }
      expect(seen).toHaveLength(8);
    });
  });

  /* ---------------------------------------------------------------- */
  /* The optimistic like                                                */
  /* ---------------------------------------------------------------- */

  describe('the optimistic like', () => {
    it('moves the label and the count LOCALLY, with no server count to move them from', async () => {
      // The observable consequence of the optimistic write SURVIVING a success.
      // There is no count in the response — `toggleLike` returns `{status}` and
      // nothing else — so the number on screen can only have come from the local
      // delta. A "refresh the count from the server" implementation has no number
      // to read and would reach for `AudioClip.likes`, which is stale by up to
      // 300s and does not move at all for this viewer's own like.
      //
      // What is NOT asserted here, and cannot be, is that the write happened
      // BEFORE the response: see "THE MID-FLIGHT WINDOW IS NOT OBSERVABLE HERE".
      mockToggleLike.mockResolvedValue({ status: 'liked' });
      const r = await renderCluster();

      expect(labelOf(r, LIKE)).toBe(`Like, ${LIKES} likes`);
      expect(shownCount(r, LIKE)).toBe(String(LIKES));

      await fireEvent.press(node(r, LIKE));
      await settle();

      expect(labelOf(r, LIKE)).toBe(`Unlike, ${LIKES + 1} likes`);
      expect(shownCount(r, LIKE)).toBe(String(LIKES + 1));
      // The endpoint was handed an id and NOTHING else — no count, no direction.
      expect(mockToggleLike.mock.calls[0]).toEqual([CLIP]);
    });

    it('is at rest — not busy — both before and after a request', async () => {
      // The one half of the in-flight state that IS observable: `busy` is false
      // at both ends, so it is not a latch that sticks on after a failure.
      mockToggleLike.mockResolvedValue({ status: 'liked' });
      const r = await renderCluster();
      expect(node(r, LIKE).props.accessibilityState.busy).toBe(false);

      await fireEvent.press(node(r, LIKE));
      await settle();

      expect(node(r, LIKE).props.accessibilityState.busy).toBe(false);
      expect(node(r, LIKE).props.accessibilityState.disabled).toBe(false);
    });

    it('reconciles from the response even when the server REVERSES the guess', async () => {
      // The direction that matters: the optimistic guess is proven WRONG. The
      // heart lands on the server's answer rather than on the guess.
      mockToggleLike.mockResolvedValue({ status: 'unliked' });
      const r = await renderCluster();

      await fireEvent.press(node(r, LIKE));
      await settle();

      expect(labelOf(r, LIKE)).toBe('Like, 13 likes');
    });

    it('leaves the COUNT unreconciled when the server reverses the guess, and says so', async () => {
      // ⚠️ A REAL, DELIBERATE INCONSISTENCY, pinned rather than hidden. The count
      // has no server value to correct it from — `toggleLike` returns only
      // `{status}` and `AudioClip.likes` is stale by up to 300s — so when the
      // server reverses the guess the heart follows it and the number cannot.
      // The cluster then reads "not liked, 13 likes" until the feed refetches.
      //
      // The alternative — reverting the count on a mismatched `status` — would be
      // a guess in the other direction: the component would have to invent a count
      // the server never sent. Whoever wires this up should know the divergence
      // exists rather than discover it on a device.
      mockToggleLike.mockResolvedValue({ status: 'unliked' });
      const r = await renderCluster();

      await fireEvent.press(node(r, LIKE));
      await settle();

      const label = String(labelOf(r, LIKE));
      expect(label.startsWith('Like,')).toBe(true);
      expect(shownCount(r, LIKE)).toBe(String(LIKES + 1));
      // ...and the two halves of the label disagree, which is the point.
      expect(label).toBe('Like, 13 likes');
    });

    it('sends exactly one POST, for the clip it was rendered for', async () => {
      const r = await renderCluster();
      await fireEvent.press(node(r, LIKE));
      await settle();

      expect(mockToggleLike).toHaveBeenCalledTimes(1);
      expect(mockToggleLike).toHaveBeenCalledWith(CLIP);
    });

    it('calls the endpoint on the UNLIKE direction too, and settles unliked', async () => {
      mockToggleLike.mockResolvedValue({ status: 'unliked' });
      const r = await renderCluster({ isLiked: true, likeCount: LIKES });

      expect(labelOf(r, LIKE)).toBe(`Unlike, ${LIKES} likes`);
      await fireEvent.press(node(r, LIKE));
      await settle();

      // There is no idempotent "set liked": the un-like is the same POST.
      expect(mockToggleLike).toHaveBeenCalledTimes(1);
      expect(mockToggleLike).toHaveBeenCalledWith(CLIP);
      expect(labelOf(r, LIKE)).toBe(`Like, ${LIKES - 1} likes`);
    });

    it('never drives the count below zero, even from a count of 0', async () => {
      // The reachable case: a clip this viewer has NOT liked whose server count
      // is 0 — liked optimistically, or carried in from a stale prop — and then
      // unliked. The feed's count is stale by up to 300s (the flush beat), so 0
      // and "liked" genuinely disagree.
      mockToggleLike.mockResolvedValue({ status: 'unliked' });
      const r = await renderCluster({ isLiked: true, likeCount: 0 });

      await fireEvent.press(node(r, LIKE));
      expect(shownCount(r, LIKE)).toBe('0');
      await settle();

      expect(shownCount(r, LIKE)).toBe('0');
      expect(labelOf(r, LIKE)).toBe('Like, 0 likes');
      expect(String(labelOf(r, LIKE))).not.toContain('-1');
    });

    it('never shows a negative count across ten alternating presses', async () => {
      // The invariant rather than one instance of it. The server alternates
      // `liked`/`unliked` so the control really does toggle in both directions,
      // and every rendered count is checked rather than only the last.
      const r = await renderCluster({ likeCount: 0 });
      const seen: number[] = [];

      for (let i = 0; i < 10; i += 1) {
        mockToggleLike.mockResolvedValueOnce({ status: i % 2 === 0 ? 'liked' : 'unliked' });
        await fireEvent.press(node(r, LIKE));
        await settle();
        seen.push(Number(shownCount(r, LIKE)));
      }

      expect(mockToggleLike).toHaveBeenCalledTimes(10);
      expect(seen).toHaveLength(10);
      for (const n of seen) {
        expect(Number.isFinite(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
      }
    });
  });

  /* ---------------------------------------------------------------- */
  /* The rule itself                                                    */
  /* ---------------------------------------------------------------- */

  describe('nextLikeCount', () => {
    it('steps up on like and down on unlike', () => {
      expect(nextLikeCount(12, true)).toBe(13);
      expect(nextLikeCount(12, false)).toBe(11);
      expect(nextLikeCount(0, true)).toBe(1);
    });

    it('never returns a negative or non-finite number, from ANY input', () => {
      for (const current of [0, 1, 2, 1000]) {
        expect(nextLikeCount(current, false)).toBeGreaterThanOrEqual(0);
      }
      // `z.number()` does not exclude these, so the rule has to.
      for (const current of [-1, -999, Number.NaN, Infinity, -Infinity]) {
        for (const next of [true, false]) {
          const out = nextLikeCount(current, next);
          expect(Number.isFinite(out)).toBe(true);
          expect(out).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('clamps a negative base to 0 BEFORE adding, so like-from-(-1) is 1', () => {
      expect(nextLikeCount(-1, true)).toBe(1);
    });
  });

  /* ---------------------------------------------------------------- */
  /* The optimistic step, as a pure function                            */
  /* ---------------------------------------------------------------- */

  /**
   * The optimistic WRITE is not observable through the renderer — the file
   * header's mid-flight section has the measurements. What IS assertable is
   * that the two writes are PAIRED and computed from the same captured values,
   * and that is what a bug here looks like: the heart moving while the count
   * does not, or the count moving in the opposite direction to the heart.
   */
  describe('optimisticLike', () => {
    it('flips the flag and the count together, in the same direction', () => {
      expect(optimisticLike({ liked: false, count: 12 })).toEqual({ liked: true, count: 13 });
      expect(optimisticLike({ liked: true, count: 12 })).toEqual({ liked: false, count: 11 });
    });

    it('never produces a negative count, from any input', () => {
      for (const count of [0, 1, 2, 1000, -1, Number.NaN, Infinity]) {
        for (const liked of [true, false]) {
          const out = optimisticLike({ liked, count });
          expect(Number.isFinite(out.count)).toBe(true);
          expect(out.count).toBeGreaterThanOrEqual(0);
          // The pairing: the flag flipped, so the count moved in THAT direction.
          expect(out.liked).toBe(!liked);
          if (out.liked) expect(out.count).toBeGreaterThanOrEqual(count === 0 ? count : 0);
        }
      }
    });

    it('is its own inverse for a count the floor does not interfere with', () => {
      // A toggle applied twice is the identity — which is the whole reason a
      // stray second request is survivable at all, and the reason the endpoint
      // being a toggle rather than a set is not automatically fatal.
      for (const view of [
        { liked: false, count: 0 },
        { liked: false, count: 7 },
        { liked: true, count: 7 },
        { liked: true, count: 1 },
      ]) {
        expect(optimisticLike(optimisticLike(view))).toEqual(view);
      }
    });

    it('is total, and treats an unusable count as none rather than inventing one', () => {
      // NaN in, 0 out — the count stays UNKNOWN rather than becoming 1. Adding 1
      // to a number nobody can read would be a fabrication, and it would also
      // disagree with `countLabel`, which already renders a NaN count as 0. The
      // heart still flips, because that part of the state is not a number.
      for (const count of [Number.NaN, Infinity, -Infinity]) {
        expect(() => optimisticLike({ liked: false, count })).not.toThrow();
        expect(optimisticLike({ liked: false, count })).toEqual({ liked: true, count: 0 });
        expect(optimisticLike({ liked: true, count })).toEqual({ liked: false, count: 0 });
      }
    });
  });

  /* ---------------------------------------------------------------- */
  /* Reconciliation                                                     */
  /* ---------------------------------------------------------------- */

  describe("the server's `status` is the authority, not the optimistic guess", () => {
    it('ends UNLIKED on a resolved body saying unliked', async () => {
      // The load-bearing asymmetry. `apiFetch` returns only the parsed body
      // (`client.ts:304-335`), so the HTTP code is not even AVAILABLE to this
      // component — and the endpoint answers 200 for both directions anyway. A
      // resolved promise IS success, and the STRING is the answer.
      mockToggleLike.mockResolvedValue({ status: 'unliked' });
      const r = await renderCluster();

      await fireEvent.press(node(r, LIKE));
      await settle();

      // The LABEL is the discriminator: it starts 'Unlike' (the guess) and ends
      // 'Like' (the server). An implementation that trusted its guess — or read
      // the HTTP code, which is 200 for both — lands on 'Unlike' and fails here.
      expect(labelOf(r, LIKE)).toBe('Like, 13 likes');
    });

    it('ends LIKED on a resolved body saying liked', async () => {
      mockToggleLike.mockResolvedValue({ status: 'liked' });
      const r = await renderCluster();

      await fireEvent.press(node(r, LIKE));
      await settle();

      expect(labelOf(r, LIKE)).toBe(`Unlike, ${LIKES + 1} likes`);
    });

    it('reconciles in BOTH directions, not just the one the guess got right', async () => {
      // An implementation that trusted its own guess passes the liked case and
      // fails only here, so the table is the whole claim.
      // The LABEL only: the count has no server source, so it is the local
      // optimistic value in both rows (pinned above, and in the
      // "reverses the guess" pair). Asserting it here too would restate one fact
      // twice rather than add a second.
      for (const [status, expectedLiked] of [
        ['liked', true],
        ['unliked', false],
      ] as const) {
        const r = await renderCluster();
        mockToggleLike.mockResolvedValue({ status });
        await fireEvent.press(node(r, LIKE));
        await settle();
        const label = String(labelOf(r, LIKE));
        expect({ status, verb: label.split(',')[0] }).toEqual({
          status,
          verb: expectedLiked ? 'Unlike' : 'Like',
        });
        // The optimistic +1 stands either way: the endpoint has no count.
        expect(label).toBe(`${expectedLiked ? 'Unlike' : 'Like'}, ${LIKES + 1} likes`);
        await r.unmount();
      }
    });

    it('takes NO count from the response, because there is none to take', async () => {
      // `toggleLike` returns only `{status}` (`endpoints/interactions.ts:78-91`),
      // so a "refresh the count from the server" implementation has no number to
      // read and would reach for `AudioClip.likes` — which is stale by up to 300s
      // and does not move for this viewer's own like. This is the assertion that
      // says the local optimistic value survives a SUCCESS.
      const r = await renderCluster({ likeCount: LIKES });

      await fireEvent.press(node(r, LIKE));
      await settle();

      expect(shownCount(r, LIKE)).toBe(String(LIKES + 1));
      expect(labelOf(r, LIKE)).toBe(`Unlike, ${LIKES + 1} likes`);
    });
  });

  /* ---------------------------------------------------------------- */
  /* Rollback                                                           */
  /* ---------------------------------------------------------------- */

  describe('a rejected like', () => {
    it('restores BOTH the label and the count', async () => {
      // THE test. A rollback that restores only the heart leaves the count one
      // too high for ever, and the two then disagree with each other on screen.
      //
      // It is seeded with a NON-ZERO count on purpose. From `likeCount: 0` the
      // rollback's target and its starting point are the same number, so the
      // count half would pass even with no rollback at all — which is exactly the
      // shape of a false pass, and the reason the "never below zero" test seeds
      // 0 while this one seeds a count the delta actually moves.
      mockToggleLike.mockRejectedValue(new Error('Network request failed'));
      const r = await renderCluster({ isLiked: false, likeCount: LIKES });

      expect(labelOf(r, LIKE)).toBe(`Like, ${LIKES} likes`);
      expect(shownCount(r, LIKE)).toBe(String(LIKES));

      await fireEvent.press(node(r, LIKE));
      await settle();

      expect(labelOf(r, LIKE)).toBe(`Like, ${LIKES} likes`);
      expect(shownCount(r, LIKE)).toBe(String(LIKES));
    });

    it('restores the captured COUNT in BOTH directions', async () => {
      // A rejected LIKE (count up) and a rejected UNLIKE (count down). An
      // inverted-delta rollback is only correct in both while nothing else moved
      // the number underneath it; a captured pair is correct by construction
      // (`frontend/src/components/feed/ReelCard.tsx:110-111` inverts).
      const rejected = new Error('Network request failed');

      mockToggleLike.mockRejectedValue(rejected);
      const up = await renderCluster();
      await fireEvent.press(node(up, LIKE));
      await settle();
      expect({ label: labelOf(up, LIKE), count: shownCount(up, LIKE) }).toEqual({
        label: `Like, ${LIKES} likes`,
        count: String(LIKES),
      });
      await up.unmount();

      mockToggleLike.mockRejectedValue(rejected);
      const down = await renderCluster({ isLiked: true, likeCount: LIKES });
      await fireEvent.press(node(down, LIKE));
      await settle();
      expect({ label: labelOf(down, LIKE), count: shownCount(down, LIKE) }).toEqual({
        label: `Unlike, ${LIKES} likes`,
        count: String(LIKES),
      });
    });

    it('never retries, and asks for exactly one attempt', async () => {
      // A retry after a timeout SILENTLY UNLIKES: the endpoint flips
      // `is_active` on the same row, so a second POST lands the clip in the
      // opposite state from the one the user asked for — and shows them nothing.
      mockToggleLike.mockRejectedValue(new Error('Network request failed'));
      const r = await renderCluster();

      await fireEvent.press(node(r, LIKE));
      await settle();
      // Extra ticks: a retry would be scheduled, not written by hand.
      await settle();
      await settle();

      expect(mockToggleLike).toHaveBeenCalledTimes(1);
    });

    it('leaves the button usable, and the next press starts from the restored state', async () => {
      mockToggleLike
        .mockRejectedValueOnce(new Error('Network request failed'))
        .mockResolvedValueOnce({ status: 'liked' });
      const r = await renderCluster();

      await fireEvent.press(node(r, LIKE));
      await settle();
      expect(labelOf(r, LIKE)).toBe(`Like, ${LIKES} likes`);

      await fireEvent.press(node(r, LIKE));
      await settle();

      expect(mockToggleLike).toHaveBeenCalledTimes(2);
      expect(labelOf(r, LIKE)).toBe(`Unlike, ${LIKES + 1} likes`);
    });
  });

  /* ---------------------------------------------------------------- */
  /* The in-flight guard                                                */
  /* ---------------------------------------------------------------- */

  describe('the toggle-in-flight guard', () => {
    it('sends exactly one request per press', async () => {
      // ⚠️ THE LIMIT OF THIS BLOCK, stated up front. "Two rapid presses produce
      // one request" is NOT assertable here: a press is only concurrent with
      // another press while the first is in flight, and an in-flight press is
      // exactly what the harness cannot return from (see the mid-flight section
      // of the file header). Four routes were measured and all four fail — the
      // workable one poisons every later test in the file.
      //
      // What IS covered, and covers the guard's LOGIC: the `canToggleLike` unit
      // tests above, over all four inputs. What is NOT covered: that `pending`
      // reaches the button's `disabled` and not only the handler's guard. That is
      // a two-line wiring fact, and a code review is the only check on it.
      mockToggleLike.mockResolvedValue({ status: 'liked' });
      const r = await renderCluster();

      await fireEvent.press(node(r, LIKE));
      await settle();
      expect(mockToggleLike).toHaveBeenCalledTimes(1);

      // A settled press re-arms: the second is a real second toggle, not a
      // refusal, which is the same property read from the other side.
      mockToggleLike.mockResolvedValue({ status: 'unliked' });
      await fireEvent.press(node(r, LIKE));
      await settle();
      expect(mockToggleLike).toHaveBeenCalledTimes(2);
    });

    it('refuses to send anything at all while the CALLER has disabled the cluster', async () => {
      // The `disabled` half of the gate, end to end — the half that needs no
      // in-flight state to observe.
      const r = await renderCluster({ disabled: true });
      await fireEvent.press(node(r, LIKE));
      await settle();
      expect(mockToggleLike).not.toHaveBeenCalled();
    });

    it('re-arms once the request settles, so the next press is a real toggle', async () => {
      // Both directions, so "re-arms" is not merely "the button came back".
      mockToggleLike.mockResolvedValueOnce({ status: 'liked' }).mockResolvedValueOnce({
        status: 'unliked',
      });
      const r = await renderCluster();

      await fireEvent.press(node(r, LIKE));
      await settle();
      expect(labelOf(r, LIKE)).toBe(`Unlike, ${LIKES + 1} likes`);

      await fireEvent.press(node(r, LIKE));
      await settle();
      expect(labelOf(r, LIKE)).toBe(`Like, ${LIKES} likes`);

      expect(mockToggleLike).toHaveBeenCalledTimes(2);
    });
  });

  /* ---------------------------------------------------------------- */
  /* A visible failure                                                  */
  /* ---------------------------------------------------------------- */

  describe('a failure is announced, and the announcement is cleared', () => {
    it('renders an accessible alert, and nothing at all when it succeeds', async () => {
      mockToggleLike.mockResolvedValue({ status: 'liked' });
      const ok = await renderCluster();
      await fireEvent.press(node(ok, LIKE));
      await settle();
      expect(queryNode(ok, ERROR)).toBeNull();

      mockToggleLike.mockRejectedValue(new Error('Network request failed'));
      const bad = await renderCluster();
      await fireEvent.press(node(bad, LIKE));
      await settle();

      const alert = node(bad, ERROR);
      expect(alert.props.accessibilityRole).toBe('alert');
      expect(alert.props.accessibilityLiveRegion).toBe('polite');
      expect(
        alert.queryAll((n) => String(n.props?.children) === LIKE_ERROR_COPY),
      ).toHaveLength(1);
      // A rolled-back heart is visually identical to a successful un-like, so
      // the message is the only signal that anything failed.
      expect(labelOf(bad, LIKE)).toBe(`Like, ${LIKES} likes`);
    });

    it('clears on the next press, and a next success leaves it cleared', async () => {
      mockToggleLike.mockRejectedValue(new Error('Network request failed'));
      const r = await renderCluster();
      await fireEvent.press(node(r, LIKE));
      await settle();
      expect(queryNode(r, ERROR)).not.toBeNull();

      // Cleared at the START of a press, not on success: a stale failure left up
      // over a heart that has already moved back reads as a second, later
      // failure (`frontend/src/components/feed/ReelCard.tsx:100`).
      mockToggleLike.mockResolvedValue({ status: 'liked' });
      await fireEvent.press(node(r, LIKE));
      expect(queryNode(r, ERROR)).toBeNull();

      await settle();
      expect(queryNode(r, ERROR)).toBeNull();
      expect(labelOf(r, LIKE)).toBe(`Unlike, ${LIKES + 1} likes`);
    });

    it('says the same words the web client says', async () => {
      // One failure, one explanation, across the two clients.
      mockToggleLike.mockRejectedValue(new Error('Network request failed'));
      const r = await renderCluster();
      await fireEvent.press(node(r, LIKE));
      await settle();
      expect(LIKE_ERROR_COPY).toBe('Could not update like. Try again.');
      expect(
        node(r, ERROR).queryAll((n) => String(n.props?.children) === LIKE_ERROR_COPY),
      ).toHaveLength(1);
    });

    it('never takes a tap while it is showing', async () => {
      // It is a message, not a control.
      mockToggleLike.mockRejectedValue(new Error('Network request failed'));
      const r = await renderCluster();
      await fireEvent.press(node(r, LIKE));
      await settle();
      expect(node(r, ERROR).props.pointerEvents).toBe('none');
    });
  });

  /* ---------------------------------------------------------------- */
  /* Comments and share                                                 */
  /* ---------------------------------------------------------------- */

  describe('comments and share', () => {
    it('fire their callbacks with no arguments', async () => {
      const onOpenComments = jest.fn();
      const onOpenShare = jest.fn();
      const r = await renderCluster({ onOpenComments, onOpenShare });

      await fireEvent.press(node(r, COMMENT));
      expect(onOpenComments).toHaveBeenCalledTimes(1);
      expect(onOpenComments).toHaveBeenCalledWith();

      await fireEvent.press(node(r, SHARE));
      expect(onOpenShare).toHaveBeenCalledTimes(1);
      expect(onOpenShare).toHaveBeenCalledWith();

      // Neither is a like, so neither may touch the endpoint.
      expect(mockToggleLike).not.toHaveBeenCalled();
    });

    it('refuses share, and says so WITHOUT leaking why, when the clip is not shareable', async () => {
      const onOpenShare = jest.fn();
      const r = await renderCluster({ isShareable: false, onOpenShare, shareCount: 7 });

      expect(labelOf(r, SHARE)).toBe('Share unavailable for this clip');
      expect(node(r, SHARE).props.accessibilityState.disabled).toBe(true);
      expect(node(r, SHARE).props.onStartShouldSetResponder()).toBe(false);
      // SECURITY: `ReelCard.cardStatusReport` collapses 403 and 404 into one
      // message for exactly this reason — a caller holding a UUID must not learn
      // moderation or licensing state from a label (`ReelCard.tsx:332-343`).
      expect(String(labelOf(r, SHARE))).not.toMatch(/licen|right|moder|non-?com|share-?alike/i);

      await fireEvent.press(node(r, SHARE));
      expect(onOpenShare).not.toHaveBeenCalled();
    });

    it('still allows comments on a clip that cannot be shared', async () => {
      const onOpenComments = jest.fn();
      const r = await renderCluster({ isShareable: false, onOpenComments });
      await fireEvent.press(node(r, COMMENT));
      expect(onOpenComments).toHaveBeenCalledTimes(1);
    });
  });

  /* ---------------------------------------------------------------- */
  /* The disabled cluster                                               */
  /* ---------------------------------------------------------------- */

  describe('the disabled cluster', () => {
    it('suppresses all three presses and reports disabled on all three', async () => {
      const onOpenComments = jest.fn();
      const onOpenShare = jest.fn();
      const r = await renderCluster({ disabled: true, onOpenComments, onOpenShare });

      for (const id of [LIKE, COMMENT, SHARE]) {
        const b = node(r, id);
        expect({ id, disabled: b.props.accessibilityState.disabled }).toEqual({ id, disabled: true });
        expect({ id, responder: b.props.onStartShouldSetResponder() }).toEqual({
          id,
          responder: false,
        });
        await fireEvent.press(b);
      }

      expect(mockToggleLike).not.toHaveBeenCalled();
      expect(onOpenComments).not.toHaveBeenCalled();
      expect(onOpenShare).not.toHaveBeenCalled();
    });

    it('is re-enabled by the caller, and the props are the only input', async () => {
      const props = baseProps({ disabled: true });
      const r = await render(<ActionCluster {...props} />);
      expect(node(r, LIKE).props.accessibilityState.disabled).toBe(true);

      await r.rerender(<ActionCluster {...props} disabled={false} />);

      expect(node(r, LIKE).props.accessibilityState.disabled).toBe(false);
      await fireEvent.press(node(r, LIKE));
      expect(mockToggleLike).toHaveBeenCalledTimes(1);
      await settle();
    });

    it('reports `disabled` from the caller and never from an in-flight like', async () => {
      // `busy` is the ONLY thing the in-flight state contributes to
      // `accessibilityState`, and the comment/share buttons never carry it —
      // which is the observable half of "a slow like does not lock the reel".
      const r = await renderCluster();
      await fireEvent.press(node(r, LIKE));
      await settle();

      for (const id of [COMMENT, SHARE]) {
        expect(node(r, id).props.accessibilityState.busy).toBeUndefined();
        expect(node(r, id).props.accessibilityState.disabled).toBe(false);
      }
    });
  });

  /* ---------------------------------------------------------------- */
  /* Hydration                                                          */
  /* ---------------------------------------------------------------- */

  describe('hydration from the props', () => {
    it('adopts a new isLiked / likeCount when the CALLER re-sends them', async () => {
      // A feed refill is the only thing that can move these, and it is the one
      // path allowed to overwrite an optimistic state.
      const r = await renderCluster();
      await r.rerender(<ActionCluster {...baseProps({ isLiked: true, likeCount: LIKES + 1 })} />);

      expect(labelOf(r, LIKE)).toBe(`Unlike, ${LIKES + 1} likes`);
      expect(shownCount(r, LIKE)).toBe(String(LIKES + 1));
    });

    it('does NOT undo an optimistic toggle on an unrelated re-render', async () => {
      // The keyed-effect property. An unconditional write in an effect with no
      // dependency list — or one keyed on something else — would put the heart
      // back the instant the reel re-rendered for any other reason (a token
      // tick, a neighbour's status), and the user would watch their own like
      // spring back.
      mockToggleLike.mockResolvedValue({ status: 'liked' });
      const r = await renderCluster();

      await fireEvent.press(node(r, LIKE));
      await settle();
      expect(labelOf(r, LIKE)).toBe(`Unlike, ${LIKES + 1} likes`);

      // Identical values, new element identity.
      await r.rerender(<ActionCluster {...baseProps()} />);

      expect(labelOf(r, LIKE)).toBe(`Unlike, ${LIKES + 1} likes`);
      expect(shownCount(r, LIKE)).toBe(String(LIKES + 1));
    });
  });

  /* ---------------------------------------------------------------- */
  /* Accessibility                                                      */
  /* ---------------------------------------------------------------- */

  describe('naming', () => {
    it('names the NEXT ACTION, so the label changes with the state', async () => {
      mockToggleLike.mockResolvedValue({ status: 'liked' });
      const r = await renderCluster();

      expect(labelOf(r, LIKE)).toBe('Like, 12 likes');
      await fireEvent.press(node(r, LIKE));
      expect(labelOf(r, LIKE)).toBe('Unlike, 13 likes');
      await settle();
      expect(labelOf(r, LIKE)).toBe('Unlike, 13 likes');

      mockToggleLike.mockResolvedValue({ status: 'unliked' });
      await fireEvent.press(node(r, LIKE));
      await settle();
      expect(labelOf(r, LIKE)).toBe('Like, 12 likes');
    });

    it('never says "Like button", and never announces the state TWICE', async () => {
      // The brief's own wording for the label. And the reason there is no
      // `selected`/`checked` in `accessibilityState`: a state-changing label
      // plus a state flag is exactly the double-announce the web client's own
      // comment argues against (`frontend/src/components/feed/ReelCard.tsx:207-210`).
      // `toBeUndefined` rather than `not.toHaveProperty`, because RN's host node
      // carries `selected: undefined` as an explicit key and `toHaveProperty`
      // reports that as present.
      const r = await renderCluster();
      const state = node(r, LIKE).props.accessibilityState;

      expect(String(labelOf(r, LIKE))).not.toContain('button');
      expect(state.selected).toBeUndefined();
      expect(state.checked).toBeUndefined();
    });

    it('carries the count in the NAME and hides it from AT, so it is read once', async () => {
      // In RN every `<Text>` is its own accessibility element, so an unhidden
      // count is a second focus stop that says "12" on its own — the RN form of
      // the bug the web fixed at `…/ReelCard.tsx:485-488, 513-516`.
      //
      // `shareCount` is passed so all three counts exist: the share button renders
      // no count node at all without it, and a missing node would satisfy a loop
      // that only checked what is there.
      const r = await renderCluster({ shareCount: 5 });
      expect(shownCount(r, SHARE)).toBe('5');

      for (const id of [LIKE, COMMENT, SHARE]) {
        const count = node(r, `${id}-count`);
        expect({ id, ariaHidden: count.props['aria-hidden'] }).toEqual({ id, ariaHidden: true });
      }
      expect(String(labelOf(r, LIKE))).toContain('12');
      expect(String(labelOf(r, COMMENT))).toContain(String(COMMENTS));
    });

    it('pluralises, and reads zero or garbage as none rather than undefined/NaN', async () => {
      const one = await renderCluster({ likeCount: 1, commentCount: 1, shareCount: 1 });
      expect(labelOf(one, LIKE)).toBe('Like, 1 like');
      expect(labelOf(one, COMMENT)).toBe('Comments, 1 comment');
      expect(labelOf(one, SHARE)).toBe('Share, 1 share');
      await one.unmount();

      const zero = await renderCluster({ likeCount: 0, commentCount: 0, shareCount: 0 });
      expect(labelOf(zero, LIKE)).toBe('Like, 0 likes');
      expect(labelOf(zero, COMMENT)).toBe('Comments, 0 comments');
      expect(labelOf(zero, SHARE)).toBe('Share, 0 shares');
      await zero.unmount();

      // A count the server sent as NaN must never reach a label as "NaN likes".
      const broken = await renderCluster({ likeCount: Number.NaN, commentCount: Number.NaN });
      expect(labelOf(broken, LIKE)).toBe('Like, 0 likes');
      expect(labelOf(broken, COMMENT)).toBe('Comments, 0 comments');
      for (const id of [LIKE, COMMENT, SHARE]) {
        expect(String(labelOf(broken, id))).not.toContain('undefined');
        expect(String(labelOf(broken, id))).not.toContain('NaN');
      }
    });
  });

  describe('the like state survives a monochrome renderer', () => {
    it('is carried by the glyph FILL, not only by colour', async () => {
      mockToggleLike.mockResolvedValue({ status: 'liked' });
      const r = await renderCluster();

      expect(glyphProps(node(r, LIKE)).fill).toBe('none');
      await fireEvent.press(node(r, LIKE));
      await settle();

      // ...and not merely a different colour: the source's own 1.15 scale, which
      // `LIKED_GLYPH_SCALE` names so the two cannot drift.
      expect(glyphProps(node(r, LIKE)).fill).toBe(status.dangerOn);
      expect(glyphScale(node(r, LIKE))).toBe(LIKED_GLYPH_SCALE);
      expect(LIKED_GLYPH_SCALE).toBe(1.15);
    });

    it('is carried on a THIRD channel too — the circle background', async () => {
      const off = await renderCluster();
      expect(styleOf(node(off, LIKE)).backgroundColor).toBe(glass.background);
      await off.unmount();

      const on = await renderCluster({ isLiked: true });
      expect(styleOf(node(on, LIKE)).backgroundColor).toBe(brand.like);
      // The other two circles have no "on" state, so their background never moves.
      expect(styleOf(node(on, COMMENT)).backgroundColor).toBe(glass.background);
      expect(styleOf(node(on, SHARE)).backgroundColor).toBe(glass.background);
    });

    it('draws the glyph on a foreground that actually reads on the filled circle', async () => {
      // The source paints white on `--error` (#ffb4ab), about 1.9:1. The token for
      // a foreground on that surface is `status.dangerOn` (globals.css:38).
      const r = await renderCluster({ isLiked: true });
      const glyph = glyphProps(node(r, LIKE));

      expect(glyph.stroke).toBe(status.dangerOn);
      expect(glyph.stroke).not.toBe(content.primary);
      expect(status.dangerOn).toBe('#690005');
    });
  });

  /* ---------------------------------------------------------------- */
  /* The touch target floor                                             */
  /* ---------------------------------------------------------------- */

  describe('the touch target floor', () => {
    it('clears the platform minimum on the LAYOUT BOX of all three', async () => {
      const r = await renderCluster();
      // jest-expo runs as ios, so `MIN_TOUCH_TARGET` is the 44 pt floor here; the
      // Android arm is 48 dp and arrives through the same `Platform.select`.
      const floor =
        Platform.OS === 'android'
          ? accessibility.minTouchTargetAndroid
          : accessibility.minTouchTargetIOS;

      for (const id of [LIKE, COMMENT, SHARE]) {
        const style = styleOf(node(r, id));
        expect({ id, minWidth: style.minWidth, minHeight: style.minHeight }).toEqual({
          id,
          minWidth: MIN_TOUCH_TARGET,
          minHeight: MIN_TOUCH_TARGET,
        });
        expect(style.minWidth as number).toBeGreaterThanOrEqual(floor);
        expect(style.minHeight as number).toBeGreaterThanOrEqual(floor);
        expect(style.alignItems).toBe('center');
        expect(style.justifyContent).toBe('center');
      }

      expect(accessibility.minTouchTargetIOS).toBe(44);
      expect(accessibility.minTouchTargetAndroid).toBe(48);
    });

    it("is its OWN target, unlike the transport's 40px circles — because 56 clears both", async () => {
      // The one place this file departs from `ClipTransport`'s two-box
      // resolution: that file's circles are 40, which fails 44 AND 48, so it had
      // to wrap them in a floor-sized box. 56 fails neither, so target and visual
      // are the same element and there is no wrapper to get wrong. `minWidth`
      // stays at the floor while `width`/`height` are the 56px design value —
      // `touchableStyle` composes both rather than overriding.
      const r = await renderCluster();
      const style = styleOf(node(r, LIKE));

      expect(ACTION_BUTTON_SIZE).toBe(56);
      expect(ACTION_BUTTON_SIZE).toBeGreaterThanOrEqual(accessibility.minTouchTargetIOS);
      expect(ACTION_BUTTON_SIZE).toBeGreaterThanOrEqual(accessibility.minTouchTargetAndroid);
      expect(style.width).toBe(ACTION_BUTTON_SIZE);
      expect(style.height).toBe(ACTION_BUTTON_SIZE);
    });

    it('carries hitSlop, and the 24px gap keeps the expansions from overlapping', async () => {
      const r = await renderCluster();

      for (const id of [LIKE, COMMENT, SHARE]) {
        expect(node(r, id).props.hitSlop).toEqual({ top: 8, bottom: 8, left: 8, right: 8 });
      }
      // 8 per side, 24px gap: they meet at the midpoint at worst, never cross.
      expect(8 * 2).toBeLessThanOrEqual(ACTION_CLUSTER_GAP);
      expect(ACTION_CLUSTER_GAP).toBe(spacing.stack);
      expect(ACTION_CLUSTER_GAP).toBe(24);
      // 56 + 16 still clears both floors, so the expansion is never the only
      // thing holding the control above them.
      expect(ACTION_BUTTON_SIZE + 16).toBeGreaterThanOrEqual(accessibility.minTouchTargetAndroid);
    });
  });

  /* ---------------------------------------------------------------- */
  /* The source's chrome                                                */
  /* ---------------------------------------------------------------- */

  describe('the circle is the source circle', () => {
    it('is a full-radius, border-less, glass-filled 56px disc', async () => {
      const r = await renderCluster();
      const style = styleOf(node(r, LIKE));

      expect(style.borderRadius).toBe(radius.full);
      expect(style.borderRadius).toBe(9999);
      // The source's action circles carry `border: 'none'` — unlike the
      // transport's, which have a hairline. No border is invented here.
      expect(style.borderWidth ?? 0).toBe(0);
      expect(style.backgroundColor).toBe(glass.background);
    });

    it('composes the column at the source gap and centres its children', async () => {
      const r = await renderCluster();
      const style = styleOf(node(r, ROOT));

      expect(style.alignItems).toBe('center');
      expect(style.gap).toBe(spacing.stack);
    });

    it("sets the count in the source's 10px / 600, with tabbed figures", async () => {
      const r = await renderCluster();
      const style = styleOf(node(r, `${LIKE}-count`));

      // ReelCard.tsx:272 — `fontSize: 10, fontWeight: 600`, which is
      // `typography.count`; `color` is the source's `#fff`.
      expect(style.fontSize).toBe(typography.count.fontSize);
      expect(style.fontWeight).toBe(typography.count.fontWeight);
      expect(style.color).toBe(content.primary);
      // ADDITION, not from the source: a proportional count changes width when
      // it crosses 9→10, so the number would jitter inside a fixed 56px circle on
      // every like. Same reasoning as `ClipTransport.tsx:520-524`.
      expect(style.fontVariant).toEqual(['tabular-nums']);
    });

    it("styles the failure in the web client's own micro-label treatment", async () => {
      mockToggleLike.mockRejectedValue(new Error('Network request failed'));
      const r = await renderCluster();
      await fireEvent.press(node(r, LIKE));
      await settle();

      const text = node(r, ERROR).queryAll(
        (n) => String(n.props?.children) === LIKE_ERROR_COPY,
      )[0] as TestInstance;
      expect(text).toBeDefined();
      const style = styleOf(text);

      // `text-[9px] font-bold uppercase tracking-wider text-red-400`
      // (frontend/src/components/feed/ReelCard.tsx:523-527) is
      // `typography.microLabel` at `status.danger`.
      expect(style.fontSize).toBe(typography.microLabel.fontSize);
      expect(style.textTransform).toBe('uppercase');
      expect(style.color).toBe(status.danger);
      // Bounded, because the column is one 56px circle wide.
      expect(styleOf(node(r, ERROR)).maxWidth).toBe(ACTION_BUTTON_SIZE * 2);
    });
  });
});
