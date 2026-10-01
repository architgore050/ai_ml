import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Heart, MessageCircle, Share2 } from 'lucide-react-native';

import { glow } from '../../design/shadows';
import { typography } from '../../design/typography';
import {
  brand,
  content,
  glass,
  radius,
  spacing,
  status,
  tint,
} from '../../design/tokens';
import { hitSlop, touchableStyle } from '../ui/primitives';
import { toggleLike } from '../../api/endpoints/interactions';

/**
 * The reel's right-hand action column: like, comments, share.
 *
 * ---------------------------------------------------------------------------
 * DESIGN SOURCE
 * ---------------------------------------------------------------------------
 * `ReelCard.tsx:253-297`, read via
 * `git show 20451d3:frontend/sample_frontend2/src/components/audio/ReelCard.tsx`
 * (that directory is gitignored; see `AmbientOrbs.tsx`'s header for why it is
 * only reachable through git). Transcribed:
 *
 *   :255-258   the column — `position:absolute, right:12, bottom:140`,
 *              `flexDirection:'column', alignItems:'center', gap:24`
 *   :260-274   like  — 56px circle, `border:none`,
 *              `background: liked ? var(--error) : var(--surface-overlay)`,
 *              `boxShadow: liked ? '0 0 20px rgba(255,180,171,0.3)' : 'none'`,
 *              `<Heart size={22} fill={liked ? '#fff' : 'none'} color="#fff">` with
 *              `transform: liked ? scale(1.15) : scale(1)`, and
 *              `{fontSize:10, color:'#fff', fontWeight:600, marginTop:2}{likes}`
 *   :277-288   comment — the same circle, `<MessageCircle size={22} color="#fff">`
 *              and `{clip.comment_count || 0}`
 *   :291-303   share — the same circle, `<Share2 size={22} color="#fff">` and
 *              `{clip.shares || 0}`
 *
 * ## THE 56 px CIRCLE IS ITS OWN TOUCH TARGET — NO TWO-BOX SPLIT
 * `ClipTransport` has to wrap its 40px circles in a floor-sized box because 40
 * fails 44pt AND 48dp. 56 fails neither (`accessibility.minTouchTargetIOS` 44,
 * `…Android` 48), so the target and the visual are the same 56px circle and
 * this file has no wrapper hierarchy to get wrong. The house `hitSlop` is 8 per
 * side, and the source's 24px column gap means two expansions meet at 16 and do
 * not overlap — the same arithmetic `ClipTransport.test.tsx:849-868` pins for
 * the 16px gap there.
 *
 * ## THE LAYER
 * `ReelCard`'s `LAYER` table (`ReelCard.tsx:66-83`) has no entry for this
 * column, and this file does not invent one: the caller owns the layer, exactly
 * as it owns `LAYER.footer` for the transport. The number the caller needs is
 * **`31`** — above `status: 30` — because (a) the source paints the cluster as
 * the card's LAST child, so it is the topmost thing inside the visual header,
 * and (b) it must clear `PlayOverlay`'s full-bleed `Pressable` at
 * `LAYER.overlay` (10) or the reel's own tap target swallows its taps
 * (`PlayOverlay.tsx:86-90`). The caller's wrapper must also carry
 * `pointerEvents="box-none"` for the reason `ClipTransport`'s root does
 * (`ReelCard.test.tsx:897-930`): a stretched layer View is itself the hit test
 * and eats the whole band.
 *
 * ## WHY THE STATE IS PROPS, NOT THE STORE
 * `ClipTransport` and `SeekProgressBar` read `usePlayerStore` directly, and
 * that is right for them: `currentTime` / `playback` are facts about ONE
 * app-wide player with no per-clip copy in the feed. A like is neither. It is
 * per-CLIP data that already sits on the `FeedClip` the card was handed, and
 * `cardStatus` is the *active* clip's token state — a cluster that read it would
 * report a mounted neighbour's status as its own. So this takes the clip facts
 * as props, and takes `disabled` as a prop too for the same reason: the caller
 * is the only place that knows both `cardStatus` and whether this card is the
 * active one.
 *
 * ---------------------------------------------------------------------------
 * THE LIKE BUTTON: A TOGGLE, NOT A SET
 * ---------------------------------------------------------------------------
 * `POST /interactions/{id}/toggle-like/` has no "set liked" variant and no
 * idempotency key — `services/interactions.py:151` flips `is_active` on the
 * same row, so a second POST flips it back. `api/endpoints/interactions.ts:156-161`
 * states the consequence and it is the whole reason this handler is shaped the
 * way it is: **a retry after a timeout silently unlikes.**
 *
 * So, in order:
 *
 *  1. **Optimistic, then reconciled from `res.status`.** The server's string is
 *     the only authority. It is NOT the HTTP status code, for two reasons that
 *     compound: `apiFetch` throws on non-2xx and returns only the parsed body
 *     (`client.ts:304-335`), so the code is *not available to any caller*; and
 *     the endpoint answers **200 for both directions** anyway.
 *  2. **One request in flight.** Guarded on the BUTTON as well as in the
 *     handler. The button guard is the one that matters on a device: a
 *     `Pressable`'s `disabled` is what makes `Pressability` return
 *     `onStartShouldSetResponder() === false`, so the second tap is refused at
 *     the responder layer and never reaches JS. The handler guard is
 *     defence-in-depth for the paths that bypass the responder (a11y activation,
 *     a replayed event), and both are computed from the same `pending` value so
 *     they cannot drift.
 *  3. **Rollback restores BOTH captured values**, not an inverted delta. The web
 *     client inverts (`frontend/src/components/feed/ReelCard.tsx:110-111`),
 *     which is equivalent only while nothing else moved the count underneath; a
 *     captured pair is correct by construction.
 *  4. **Never auto-retry, and never take a count from the server.** See the
 *     comment at the `setLiked` call below — that one looks like a bug and is
 *     not.
 *  5. **A failure is announced.** A rolled-back heart is visually identical to a
 *     successful un-like, so the rollback alone is a silent no-op. Copy is the
 *     web client's verbatim (`ReelCard.tsx:117`) so the two clients say the same
 *     thing; the live-region mechanism is `NetworkBanner`'s
 *     (`NetworkBanner.tsx:24-25`).
 *
 * ## TWO DEVIATIONS FROM THE WEB CLIENT'S TOGGLE NAMING
 * The web uses a STABLE label plus `aria-pressed`
 * (`frontend/src/components/feed/ReelCard.tsx:207-210`), and its own comment
 * argues that a state-changing label "would announce the state twice and
 * contradict the APG convention that a toggle button's label is stable across
 * states". This brief asks for the opposite — the label names the next ACTION
 * ("Like" / "Unlike") — so the label changes here **and `accessibilityState`
 * carries no `selected`/`checked`**, because carrying both is exactly the
 * double-announce the web comment warns about. `busy` is set while a request is
 * in flight, which is a different fact from the like state and does not
 * duplicate it. If the APG-stable form is preferred, it is a two-line change:
 * constant the label, add `selected: liked`.
 */

/** ReelCard.tsx:260-303 — the 56px circle every action button uses. */
export const ACTION_BUTTON_SIZE = 56;

/** ReelCard.tsx:271,282,296 — `<Heart size={22} />` / `<MessageCircle>` / `<Share2>`. */
export const ACTION_ICON_SIZE = 22;

/** ReelCard.tsx:255-258 — `gap: 24`, the gap between the three circles. */
export const ACTION_CLUSTER_GAP = spacing.stack;

/** ReelCard.tsx:272 — the source's liked heart is `scale(1.15)`. */
export const LIKED_GLYPH_SCALE = 1.15;

/** What the heart and its number currently show. */
export type LikeView = { liked: boolean; count: number };

/**
 * The whole optimistic step, as one pure function: the state a press writes
 * BEFORE the response arrives.
 *
 * ## WHY THIS IS A FUNCTION AND NOT FOUR INLINE setState CALLS
 * The optimistic WRITE is not observable from a test — see the note at the
 * component's hydration comment and the "the mid-flight window" block in
 * `__tests__/ActionCluster.test.tsx`. What IS observable is everything after
 * the response, and a non-optimistic implementation produces byte-identical
 * settled states, so no integration assertion can tell the two apart. Putting
 * the step in a total function means the pairing of the two writes (the flag
 * and the count move together, in the SAME direction, from the SAME captured
 * values) is assertable over its whole input space, which is the part that can
 * actually be wrong.
 *
 * It also cannot be half-applied: a caller that updates `liked` from one value
 * and `count` from another is the exact shape of a stale-state bug, and one
 * returned object makes that unrepresentable rather than merely discouraged.
 */
export function optimisticLike(view: LikeView): LikeView {
  const liked = !view.liked;
  return { liked, count: nextLikeCount(view.count, liked) };
}

/**
 * The count one toggle away from `current`, floored at zero.
 *
 * THE FLOOR IS LOAD-BEARING, not tidiness. `FeedClip.likes` is the value from
 * `GET /feed/`, and `AudioClip.likes` is only written by `flush_counters_to_pg`
 * on a **5-minute Celery beat** — so the feed's count is stale by up to 300s and
 * is not authoritative about the viewer's own like. The reachable case is a clip
 * this viewer has NOT liked whose server count is 0 (a like is a counter delta
 * the beat has not flushed, or a row the counter never touched): unliking that
 * from an optimistic `isLiked: true` would otherwise render **-1 likes** and
 * announce "Unlike, -1 likes".
 *
 * Exported so the rule is asserted directly over its own inputs rather than
 * only through a render, and so there is exactly one place the floor lives.
 */
export function nextLikeCount(current: number, nextLiked: boolean): number {
  if (!Number.isFinite(current)) return 0;
  const base = Math.max(0, current);
  return nextLiked ? base + 1 : Math.max(0, base - 1);
}

/**
 * The count label, pluralised, and never "undefined likes".
 *
 * `clip.comment_count || 0` in the source (`:287`, `:302`) is the `||`-not-`??`
 * shape: it also swallows a legitimate `NaN` into 0, which is the behaviour
 * wanted here (an unreadable count reads as none, not as a broken number). The
 * prop is typed `number`, so a genuinely absent count is a type error rather
 * than a runtime state; this covers the server-sent garbage case.
 */
function countLabel(count: number, singular: string, plural: string): string {
  const safe = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return `${safe} ${safe === 1 ? singular : plural}`;
}

/**
 * Verbatim from the web client (`frontend/src/components/feed/ReelCard.tsx:117`)
 * so both clients say the same thing on the same failure. "Try again" is not a
 * contradiction of the no-retry rule: the rollback restored the pre-press state,
 * so a further TAP is a first tap of a fresh toggle, not a replay of a request
 * that might have landed.
 */
export const LIKE_ERROR_COPY = 'Could not update like. Try again.';


export type ActionClusterProps = {
  /** The clip these actions act on. Sent as `toggleLike(clipId)`. */
  clipId: string;
  /** `FeedClip.is_liked` — the viewer's like, from the last feed page. */
  isLiked: boolean;
  /**
   * `FeedClip.likes`. Optimistic while this cluster holds a pending toggle; see
   * the note at `setLiked` for why a server value is never substituted.
   */
  likeCount: number;
  /** `FeedClip.comment_count`. Read-only here; the sheet does the writing. */
  commentCount: number;
  /**
   * `FeedClip.shares`, shown under the share glyph as the source does (`:302`).
   *
   * OPTIONAL and a documented addition to the brief's prop list: the source puts
   * a count under all three glyphs, and `FeedClip.shares` exists
   * (`api/schema.ts:107`), so omitting it would have been a silent visual
   * regression against the design. Omit it and the share button renders the
   * glyph alone and announces just "Share".
   */
  shareCount?: number;
  /**
   * False when the clip must not be shared (rights-restricted).
   *
   * ⚠️ NOTHING IN THE CURRENT FEED SCHEMA CAN SUPPLY THIS. `feedClipSchema`
   * (`api/schema.ts:99-116`) exposes no licence or rights field, so the caller
   * passes `true` until the feed serializer surfaces one. It is kept because the
   * prop is a gate a caller will otherwise re-implement per button, and because
   * a disabled-without-a-reason control is the failure `ClipTransport`'s docstring
   * calls out by name.
   *
   * The label deliberately says the clip cannot be shared and NOT why: a caller
   * holding only a UUID learns nothing about moderation or licensing state,
   * which is the rule `cardStatusReport` already applies to 403 and 404
   * (`ReelCard.tsx:332-343`).
   */
  isShareable: boolean;
  /**
   * True for a clip with no live actions — `processing`, `gone`, `unavailable`,
   * `auth-required`. The caller derives it from `cardStatus`, which is per-ACTIVE
   * clip and therefore only correct on the active card.
   */
  disabled: boolean;
  onOpenComments: () => void;
  onOpenShare: () => void;
};

/**
 * The three gates, as ONE object.
 *
 * Declared so the component cannot pass a stale or partial set to a predicate,
 * and so the exported functions below are callable on their own from a test with
 * a literal — the `canSkipClip` discipline in `ClipTransport.tsx:146-195`: the
 * rule lives in a function, the function is exercised directly, and the
 * component has exactly one place that consults it.
 */
export type ActionGate = {
  /** The caller's `disabled` — no live actions on this clip. */
  disabled: boolean;
  /** A like request is outstanding. `pending` is component state, not a prop. */
  pending: boolean;
  /** False when the clip must not be shared. Closes SHARE only. */
  isShareable: boolean;
};

/**
 * May a like toggle fire?
 *
 * `pending` is the in-flight guard, and it is not decoration: the endpoint is a
 * true toggle (`services/interactions.py:151` flips `is_active` on the same
 * row), so two requests land the clip back where it started and the user is
 * shown a heart that did not move.
 *
 * This predicate exists in TWO enforcement points — the `Pressable`'s
 * `disabled`, which is what makes `Pressability` answer
 * `onStartShouldSetResponder() === false` and refuse the touch before it
 * reaches JS, and the guard at the top of the handler, which is what holds for a
 * press that arrives by another route (an accessibility activation, a replayed
 * event). They read the SAME value, so they cannot drift.
 *
 * It is exported as a total function because the two points are NOT separately
 * observable from a test: RNTL refuses to deliver a `fireEvent` to a disabled
 * control, so an integration test can only ever observe the pair, never each
 * half. Asserting the function is what makes either half's removal a failure
 * rather than a silent no-op.
 */
export function canToggleLike(gate: Pick<ActionGate, 'disabled' | 'pending'>): boolean {
  return !gate.disabled && !gate.pending;
}

/**
 * May the comment sheet open?
 *
 * `pending` is deliberately NOT consulted. A slow like must not lock the reel's
 * comments: they are unrelated requests, and only one of them is outstanding.
 */
export function canOpenComments(gate: Pick<ActionGate, 'disabled'>): boolean {
  return !gate.disabled;
}

/**
 * May the share sheet open?
 *
 * `isShareable` closes share on its own, and only share. A rights-restricted clip
 * can still be liked and still be discussed; it just cannot be re-distributed,
 * and `AudioClip.is_noncommercial` / `requires_share_alike` are the only input to
 * that gate server-side.
 */
export function canOpenShare(
  gate: Pick<ActionGate, 'disabled' | 'isShareable'>,
): boolean {
  return !gate.disabled && gate.isShareable;
}

export function ActionCluster({
  clipId,
  isLiked,
  likeCount,
  commentCount,
  shareCount,
  isShareable,
  disabled,
  onOpenComments,
  onOpenShare,
}: ActionClusterProps) {
  /**
   * Local, optimistic copies. The props are the SERVER's last word; these are
   * the UI's, and the two are reconciled in one direction only — a new prop
   * value overwrites the local state, and a local update is never written back
   * to the caller's clip.
   *
   * The hydration effects are keyed on the PROP, not on every render, so a
   * re-render carrying the same value does not undo an in-flight optimistic
   * state — that is the difference between `useEffect(…, [isLiked])` and
   * `useEffect(…, [isLiked, likeCount])` plus an unconditional write.
   *
   * ⚠️ KNOWN LIMITATION, for whoever wires this up: this state is PER MOUNT. A
   * `FlatList` that unmounts a reel and remounts it on the way back
   * re-initialises from the props, and the props come from a buffer that
   * `mergeFeedPage` refuses to replace for an id it has already seen
   * (`lib/feedBuffer.ts:78-83`). So a like survives a swipe only if the caller
   * holds the like map itself and passes the current value in. The web client has
   * the identical shape (`frontend/src/components/feed/ReelCard.tsx:79-88`) and
   * the identical exposure; it is not a defect introduced here, but it is not
   * fixed here either.
   */
  const [liked, setLiked] = useState(isLiked);
  const [count, setCount] = useState(likeCount);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLiked(isLiked);
  }, [isLiked]);
  useEffect(() => {
    setCount(likeCount);
  }, [likeCount]);

  /**
   * The label names the NEXT ACTION and carries the count, so a screen reader
   * never announces the count as a bare "3" — which is exactly what the old web
   * client did, because a DOM button's accessible name is computed from its
   * content *before* `title` (`frontend/src/components/feed/ReelCard.tsx:485-488`).
   * In RN the failure mode is one step different and also fixed here: every
   * `<Text>` is its own accessibility element, so the visible count is
   * `aria-hidden` and the name lives in one place.
   */
  const likeLabel = `${liked ? 'Unlike' : 'Like'}, ${countLabel(count, 'like', 'likes')}`;
  const commentLabel = `Comments, ${countLabel(commentCount, 'comment', 'comments')}`;
  const shareLabel = isShareable
    ? shareCount === undefined
      ? 'Share'
      : `Share, ${countLabel(shareCount, 'share', 'shares')}`
    : 'Share unavailable for this clip';

  /**
   * ONE gate value, read by the two enforcement points of each action. Declared
   * before the handlers so both the `disabled` prop and the handler guard are
   * computed from this one object — the failure this prevents is a button that
   * looks live and refuses, or one that answers a tap it appeared to ignore.
   */
  const gate: ActionGate = { disabled, pending, isShareable };
  const likeEnabled = canToggleLike(gate);
  const commentEnabled = canOpenComments(gate);
  const shareEnabled = canOpenShare(gate);

  const onToggleLike = useCallback(async () => {
    // The same `likeEnabled` the button's `disabled` is derived from, not a
    // second computation. `disabled` is enforced at the responder, so this line
    // only sees a press that got past it.
    if (!likeEnabled) return;

    /**
     * Captured BEFORE the optimistic write, and restored verbatim on failure.
     * The web client inverts the delta instead
     * (`frontend/src/components/feed/ReelCard.tsx:110-111`), which drifts if the
     * count moved for any other reason between the two.
     */
    const previousLiked = liked;
    const previousCount = count;
    const next = optimisticLike({ liked, count });

    // Cleared at the START of a press, not on success. Leaving a stale failure
    // up while the heart has already moved back reads as a second, later
    // failure; and the web client does the same (`…/ReelCard.tsx:100`).
    //
    // ⚠️ EVERY WRITE IN THIS BLOCK HAPPENS BEFORE THE `await` BELOW. That
    // ordering IS the optimistic update, and it is the one property of this
    // handler that no test in this repo can observe — see the "mid-flight
    // window" section of `__tests__/ActionCluster.test.tsx`, which measures why.
    // The arithmetic and the pairing are covered by `optimisticLike`; the
    // timing is not covered anywhere and needs a device check.
    setError(null);
    setLiked(next.liked);
    setCount(next.count);
    setPending(true);

    try {
      const res = await toggleLike(clipId);

      /**
       * THE ONLY SUCCESSFUL WRITE TO `liked`, and it comes from the server's
       * string rather than from `nextLiked`.
       *
       * `count` IS DELIBERATELY NOT WRITTEN HERE, and that is not an oversight:
       * **`toggleLike` returns only `{status}`** — there is no like count in the
       * response, by design (`api/endpoints/interactions.ts:78-91`). A count
       * read from the response would have to come from somewhere else, and the
       * only other number available is `AudioClip.likes`, which is stale by up to
       * 300 s (5-minute flush beat) and does not move at all for this viewer's
       * own like. Overwriting the optimistic value with it would visibly snap
       * the count backwards the moment a like succeeded. It stays local until
       * the feed refetches. See the module docstring for the stale-by-300s
       * argument and `nextLikeCount` for the floor.
       */
      setLiked(res.status === 'liked');
    } catch {
      // NO RETRY, ON ANY AXIS. The endpoint is a toggle: re-POSTing after a
      // timeout lands the clip in the OPPOSITE state from the one the user
      // asked for, and does so with no error to show them
      // (`api/endpoints/interactions.ts:156-161`). Roll back, say so, stop.
      setLiked(previousLiked);
      setCount(previousCount);
      setError(LIKE_ERROR_COPY);
    } finally {
      setPending(false);
    }
  }, [clipId, count, likeEnabled, liked]);

  const onComment = useCallback(() => {
    if (!commentEnabled) return;
    onOpenComments();
  }, [commentEnabled, onOpenComments]);

  const onShare = useCallback(() => {
    if (!shareEnabled) return;
    onOpenShare();
  }, [onOpenShare, shareEnabled]);

  return (
    // `box-none` for the reason `ClipTransport`'s root carries it: this column
    // is `alignItems: 'center'` inside a layer the caller positions, and a
    // stretched ancestor makes the gap between the circles a live hit test that
    // swallows taps aimed past it. `auto` is the dead zone; `none` and
    // `box-only` would kill the three buttons. See `ReelCard.test.tsx:897-930`.
    <View testID="action-cluster" style={styles.column} pointerEvents="box-none">
      <ActionButton
        testID="action-like"
        label={likeLabel}
        onPress={onToggleLike}
        disabled={!likeEnabled}
        // `busy` is the in-flight fact and is NOT the like state, so it does not
        // duplicate what `likeLabel` already says. `accessibilityState.disabled`
        // reports the CALLER's `disabled` only — "busy" is the honest
        // announcement while a request is outstanding.
        busy={pending}
        filled={liked}
        glyph={
          <View style={[styles.glyph, liked && styles.glyphLiked]}>
            {/*
              No `testID`: `react-native-svg` does not forward it to the native
              view (`Icon.mjs` puts it on `Svg`, and the host element that renders
              is `RNSVGSvgView`), so it would be a prop that looks addressable
              and is not. The glyph is asserted by its real path `d` instead —
              which is a stronger claim, since it is the shape rather than the
              name of the component. Same convention as `ClipTransport.tsx:412-418`.
            */}
            <Heart
              size={ACTION_ICON_SIZE}
              // FILL, not only colour. WCAG 1.4.1: the liked state is carried by
              // three independent channels — the fill, the 1.15 scale
              // (`LIKED_GLYPH_SCALE`, the source's own `:272`) and the button's
              // background — so none of them is load-bearing alone.
              fill={liked ? status.dangerOn : 'none'}
              color={liked ? status.dangerOn : content.primary}
            />
          </View>
        }
        count={count}
      />

      <ActionButton
        testID="action-comment"
        label={commentLabel}
        onPress={onComment}
        disabled={!commentEnabled}
        glyph={<MessageCircle size={ACTION_ICON_SIZE} color={content.primary} />}
        count={commentCount}
      />

      <ActionButton
        testID="action-share"
        label={shareLabel}
        onPress={onShare}
        disabled={!shareEnabled}
        glyph={<Share2 size={ACTION_ICON_SIZE} color={content.primary} />}
        count={shareCount}
        // The source's share circle has no "on" state; the dim is the only
        // difference, and it is the house `uiStyles.buttonDisabled` 0.4.
        dimmed={!isShareable}
      />

      {error ? (
        // `accessibilityRole="alert"` + `accessibilityLiveRegion="polite"` is
        // `NetworkBanner.tsx:24-25`, which is the RN spelling of the web's
        // `role="status" aria-live="polite"` (`…/ReelCard.tsx:522-529`).
        // `pointerEvents="none"` so a message can never take a tap meant for
        // the buttons; it is announced, not pressed.
        //
        // PLATFORM LIMIT, stated rather than papered over: RN's live region is
        // ANDROID-only (`ViewAccessibility.d.ts:245`), and RN maps the `alert`
        // role to no iOS trait, so on iOS this is a real, focusable element with a
        // role and a name — reachable by a screen-reader user, but NOT announced
        // automatically when it appears. The correct iOS mechanism is
        // `AccessibilityInfo.announceForAccessibility`; it is not added here
        // because `NetworkBanner` sets the house pattern and changing the
        // convention is a decision above this file. It is also not a silent
        // rollback: the heart visibly unfills, and the message is in the tree.
        <View
          testID="action-like-error"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          pointerEvents="none"
          style={styles.error}
        >
          <Text numberOfLines={3} style={styles.errorText}>
            {error}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * One action: the floor-sized TARGET, which is also the 56px visual circle
 * (see the two-box note in the module docstring — there is no split here).
 */
function ActionButton({
  testID,
  label,
  onPress,
  disabled,
  busy,
  glyph,
  count,
  filled,
  dimmed,
}: {
  testID: string;
  label: string;
  onPress: () => void;
  disabled: boolean;
  busy?: boolean;
  glyph: React.ReactNode;
  /** `undefined` renders the glyph alone (the share button without a count). */
  count?: number;
  /** The ON fill. Only the like button passes it. */
  filled?: boolean;
  /** Render at the house disabled opacity for a reason other than `disabled`. */
  dimmed?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, ...(busy === undefined ? {} : { busy }) }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      // `touchableStyle` carries the floor (`MIN_TOUCH_TARGET`); `button` sets the
      // 56px circle the design specifies, which clears it on both platforms.
      style={({ pressed: isPressed }) => [
        touchableStyle(styles.button),
        filled && styles.buttonFilled,
        isPressed && styles.buttonPressed,
        (disabled || dimmed) && styles.buttonDimmed,
      ]}
    >
      {/*
        `pointerEvents: none` — the Pressable is the only hit target, the same
        reason `ClipTransport.SkipButton` puts it on its circle (`ClipTransport.tsx:509-514`).
      */}
      <View pointerEvents="none" style={styles.face}>
        {glyph}
        {count === undefined ? null : (
          // `aria-hidden`: the button's `accessibilityLabel` already carries this
          // number, and in RN a bare `<Text>` is its own accessibility element —
          // so without it the count is announced twice, once as "12" and once
          // inside the name. The web client reaches the same conclusion at
          // `…/ReelCard.tsx:513-516` for the DOM's different reason.
          <Text aria-hidden testID={`${testID}-count`} style={styles.count}>
            {count}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  /** ReelCard.tsx:255-258 — `flexDirection: column, alignItems: center, gap: 24`. */
  column: { alignItems: 'center', gap: ACTION_CLUSTER_GAP },
  /**
   * THE TARGET AND THE VISUAL. `borderRadius: var(--radius-full)`,
   * `border: none` — the source has no border on these, unlike the transport's
   * circles, so none is added.
   */
  button: {
    width: ACTION_BUTTON_SIZE,
    height: ACTION_BUTTON_SIZE,
    borderRadius: radius.full,
    backgroundColor: glass.background,
  },
  /**
   * ON: `background: var(--error)` (globals.css:37) with the source's
   * `0 0 20px rgba(255,180,171,0.3)` glow.
   *
   * THE GLYPH COLOUR IS THE ONE DEPARTURE FROM THE SOURCE. It draws white
   * (`color="#fff"`, `:271`) on `#ffb4ab`, which is about 1.9:1 — the source's
   * own "WCAG 1.4.1" heart is unreadable in its ON state. The token for a
   * foreground on this surface is `status.dangerOn` (globals.css:38, `--on-error`),
   * which is what `primitives.ts` does for `onAccent` on `accent.base`. Tokens
   * are the contract (plan §16), so the token wins over the literal.
   *
   * `tint(brand.like, '33')` is 0.33 where the source wrote 0.3: the glow scale
   * in `design/shadows.ts` has no 0.3 step and `33` is the nearest tracked one,
   * which is the same resolution `ClipTransport.tsx:589-593` took for a radius.
   * `glow()` returns `{}` on Android — that module's documented degradation — so
   * the ON state is legible on both platforms from the fill and the scale, never
   * from the shadow alone.
   */
  buttonFilled: { backgroundColor: brand.like, ...glow(20, tint(brand.like, '33')) },
  /** plan §13 "active:scale-0.96 press states", as `IconButton` and the transport. */
  buttonPressed: { opacity: 0.7, transform: [{ scale: 0.96 }] },
  /** `uiStyles.buttonDisabled` — the house 0.4 for an unavailable control. */
  buttonDimmed: { opacity: 0.4 },
  /** Icon above count, centred in the circle. `marginTop: 2` is `:272`'s. */
  face: { alignItems: 'center', justifyContent: 'center' },
  glyph: {},
  /**
   * ReelCard.tsx:272 — `transform: liked ? scale(1.15) : scale(1)`. A STATIC
   * style (no reanimated here), so `StyleSheet.flatten` on `props.style` reads
   * it honestly; that is not true of an animated value, which is frozen at its
   * mount-time value.
   */
  glyphLiked: { transform: [{ scale: LIKED_GLYPH_SCALE }] },
  /**
   * ReelCard.tsx:272 — `fontSize: 10, fontWeight: 600`, which is
   * `typography.count`; `color` is the source's `#fff`, i.e. `content.primary`.
   *
   * `fontVariant: ['tabular-nums']` is an ADDITION, for the reason
   * `ClipTransport.tsx:520-524` gives for the timecode: a proportional count
   * changes width when it crosses 9→10 or 99→100, so the number jitters inside a
   * fixed 56px circle on every like. RN spells it `fontVariant`.
   */
  count: {
    ...typography.count,
    color: content.primary,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  /**
   * The failure, in the web's own micro-label treatment
   * (`text-[9px] font-bold uppercase tracking-wider text-red-400`, `:523-527`)
   * — which is `typography.microLabel` at `status.danger`. Bounded to three lines
   * because the column is one 56px circle wide; it is a status line, not the
   * error's home.
   */
  error: { maxWidth: ACTION_BUTTON_SIZE * 2, alignItems: 'center' },
  errorText: { ...typography.microLabel, color: status.danger, textAlign: 'center' },
});
