import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Dimensions,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewToken,
} from 'react-native';

import { Button, Spinner } from '../../src/components/ui/Button';
import { NetworkBanner } from '../../src/components/NetworkBanner';
import { ReelCard } from '../../src/components/reel/ReelCard';
import { ShareModal } from '../../src/components/share/ShareModal';
import { CommentSheet } from '../../src/components/comments/CommentSheet';
import { useBackendStatus } from '../../src/hooks/useBackendStatus';
import { useFeedBuffer, useSuggestionsFallback } from '../../src/hooks/useFeedBuffer';
import { usePlaybackToken, usePrefetchPlaybackToken } from '../../src/hooks/usePlaybackToken';
import { loadClip, pause, usePlayerStore } from '../../src/store/player';
import { useAuthStore } from '../../src/store/auth';
import { decidePlaybackAction } from '../../src/lib/playbackDecision';
import {
  clampIndex,
  clipIdAtIndex,
  indexFromOffset,
  itemLayout,
  unambiguousViewableId,
} from '../../src/lib/feedViewport';
import {
  bufferRetryDelayMs,
  initialBufferWatch,
  observeBuffer,
  retryStalledClip,
  shouldAutoAdvance,
  type AdvanceLatch,
  type AdvanceReporter,
} from '../../src/lib/handsFreeAdvance';
import { useTelemetrySkip } from '../../src/hooks/useWatchTelemetry';
import { layout, spacing, surface } from '../../src/design/tokens';
import { typography } from '../../src/design/typography';
import type { FeedClip } from '../../src/api/schema';
import type { TokenStatus } from '../../src/lib/playbackTokenCache';

/**
 * The feed: vertical snap reels over ONE app-wide player.
 *
 * ## What this screen does and does not report
 * Telemetry is Phase 3 and IS reported here, through `useTelemetrySkip()` —
 * `reportUserSkip()` on a momentum-scroll end (a user leaving a reel) and
 * `reportAutoAdvance()` on natural completion. Neither call site passes a
 * number; the handle reads clipId, position and duration from the store itself,
 * which is what makes "clip A's watch time reported against clip B" unrepresentable.
 *
 * That absence was deliberate when it was written: the old app fired a skip when
 * playback reached the end, which corrupted `avg_completion_rate` and therefore
 * the recommender (defect 2). A wrong measurement is worse than no measurement,
 * so nothing was reported until `interactionGuard.shouldRegisterSkip` landed to
 * gate it — and that is what `reportAutoAdvance`'s `userInitiated: false`
 * satisfies first, before any duration is read.
 *
 * ## Not this screen's job
 * No likes, comments, shares or follows — those are `ActionCluster`,
 * `ShareModal` and `followState`, wired in Phase 3 but owned by their own
 * components.
 *
 * ## Hands-free auto-advance — and the skip it must never produce
 * Auto-advance DOES exist here, because `ClipTransport` has toggled
 * `handsFree` since it shipped and **nothing read it**. It advances off the
 * `ended` LATCH (`endedForClipId`), never off `progress >= 0.99` — see
 * `lib/handsFreeAdvance.ts` for the three ways a progress threshold is
 * reachable without the clip having finished, and for the seek-to-the-end
 * false positive this accepts on purpose.
 *
 * It reports NO skip, and reports `userInitiated: false` to whoever is
 * listening: `interactionGuard.shouldRegisterSkip` checks that field first and
 * refuses on it (`interactionGuard.ts:468`), which is what stops every natural
 * completion in a session from counting as an abandonment. `onAdvance` is the
 * seam for `useWatchTelemetry`; it is a prop rather than a module-level emitter
 * so the hook can supply it in one line when it lands.
 *
 * ## Autoplay
 * A reel plays when it is at least 70% visible, which stops a reel that is
 * merely peeking from playing under the one you are actually watching. There
 * is a 1000 ms pause between reels so a flick-scroll does not machine-gun
 * through token mints.
 */

/**
 * Not re-exported from `react-native` in RN 0.86, so declared here. `ViewToken`
 * has no `percentVisible` in this version, which is part of why reel selection
 * uses `onMomentumScrollEnd` rather than sorting viewable items by prominence.
 */
type ViewabilityInfo = {
  viewableItems: ViewToken<FeedClip>[];
  changed: ViewToken<FeedClip>[];
};

/**
 * How long to wait before re-minting a token for a still-encoding clip.
 *
 * From the backend's own 409 path: the clip exists and is approved, only the
 * HLS output is missing. 5s is the plan's value (task list 3.9).
 */
const PROCESSING_RETRY_MS = 5000;

/**
 * The feed screen. `onAdvance` remains an optional override for tests, but it is
 * NOT the production seam: expo-router renders a route with
 * `{ route, navigation, params }`, so a prop named `onAdvance` is permanently
 * `undefined` here and an advance report built on it alone would be dead code
 * that reads as wired. The screen therefore calls `useTelemetrySkip()` itself,
 * which returns a module-registry handle that is inert when no `TelemetryHost`
 * is mounted (same pattern as `onSessionExpired` in `api/client.ts:128`).
 * `userInitiated: false` is the load-bearing field of what is reported.
 */
export default function Screen({
  onAdvance,
}: {
  onAdvance?: AdvanceReporter;
} = {}) {
  const telemetry = useTelemetrySkip();
  const backend = useBackendStatus();
  const feed = useFeedBuffer();
  // `all` is now honoured server-side as "no category filter"; it used to be
  // matched literally against a free-text column and matched nothing, which is
  // why this hardcoded `music`. A cold start could only ever show one category.
  const fallback = useSuggestionsFallback('all', feed.clips.length === 0 && !feed.loading);

  const clips = feed.clips.length > 0 ? feed.clips : fallback.clips;
  const setActiveIndex = usePlayerStore((s) => s.setActiveIndex);
  const setCardStatus = usePlayerStore((s) => s.setCardStatus);
  const cardStatus = usePlayerStore((s) => s.cardStatus);
  // The native player's own state. Deliberately separate from `cardStatus`:
  // they have different producers and must not overwrite each other, or a
  // "still processing" spinner gets reset to "playing" by the next tick.
  const playback = usePlayerStore((s) => s.playback);
  /**
   * The three store facts hands-free auto-advance needs, and nothing else.
   *
   * `handsFree` is here because `ClipTransport` has been toggling it since it
   * shipped and this is the first reader — a preference nothing honours is a
   * control that lies. The two ids are the `ended` LATCH and the clip NATIVE has
   * loaded (`store/player.ts:227-236`); `shouldAutoAdvance` needs both because
   * neither alone identifies the finished clip, and their disagreement is
   * exactly the mid-swap window a second advance would fire in.
   */
  const handsFree = usePlayerStore((s) => s.handsFree);
  const playingClipId = usePlayerStore((s) => s.playingClipId);
  const endedForClipId = usePlayerStore((s) => s.endedForClipId);

  /** Guards the inter-reel pause. */
  const lastLoadAt = useRef(0);
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const [shareClip, setShareClip] = useState<FeedClip | null>(null);
  const [commentClip, setCommentClip] = useState<FeedClip | null>(null);
  const viewerId = useAuthStore((state) => state.user?.id ?? null);

  /**
   * Mirror of `activeClipId` for use inside `onMomentumScrollEnd`, which must
   * stay dependency-free (its only dependency is the viewport; re-creating it
   * on every active-clip change would churn the FlatList's props mid-scroll).
   * Written on every change so a programmatic scroll, a viewability update and
   * a momentum end all agree on what "the current clip" is.
   */
  const activeClipIdRef = useRef<string | null>(null);

  /**
   * The once-only advance latch, and the report seam, both in refs.
   *
   * A ref rather than state for each, for two different reasons that happen to
   * agree: neither is render output (writing `setState` here would re-render the
   * whole screen mid-advance), and both must be readable from INSIDE a timer
   * callback, where the closure they were created in is stale.
   */
  const advanceLatchRef = useRef<AdvanceLatch>(null);
  const onAdvanceRef = useRef(onAdvance);
  onAdvanceRef.current = onAdvance;

  /**
   * Measured viewport height. The tab bar is
   * `layout.navClearance` (100px), so a reel is the window minus the bar.
   *
   * The cells need this. `ReelCard`'s root was `flex: 1`, and a FlatList cell
   * is wrapped in a View with **no style** — so in Yoga `flex: 1` implies
   * `flexBasis: 0%` inside an auto-height parent, which resolves to **zero
   * height**, with the children overflowing. `pagingEnabled` then has no page
   * height to snap to. This is the single most likely reason nothing appeared
   * on screen, and it cannot be caught by `tsc` or a unit test.
   *
   * Some Android navigation shells do not dispatch this route's first
   * `onLayout`, even though the tab scene is already visible. Use the window
   * minus the tab clearance as a conservative initial value; a real layout
   * measurement still replaces it as soon as it arrives.
   */
  const [viewport, setViewport] = useState(() =>
    Math.max(1, Math.round(Dimensions.get('window').height - layout.navClearance)),
  );
  const listRef = useRef<FlatList<FeedClip>>(null);

  const onListLayout = useCallback((e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    // Guard against a resize loop: only commit a real change.
    setViewport((prev) => (prev === h ? prev : h));
  }, []);

  const getItemLayout = useCallback(
    (_data: ArrayLike<FeedClip> | null | undefined, index: number) =>
      itemLayout(viewport, index),
    [viewport],
  );

  /**
   * `getItemLayout` claims every cell is exactly `viewport` tall. If that is
   * ever wrong (a slow measurement, a not-yet-rendered cell), RN throws here
   * rather than silently scrolling to the wrong reel. Retrying after a frame
   * with the now-measured layout is the documented recovery.
   */
  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      requestAnimationFrame(() => {
        const i = clampIndex(info.index, clips.length);
        if (i === null) return;
        listRef.current?.scrollToIndex({ index: i, animated: true });
      });
    },
    [clips.length],
  );

  /**
   * The canonical "the user has landed on reel N" signal.
   *
   * Replaces viewability as the primary mechanism. `onMomentumScrollEnd` does
   * not fire on mount, so viewability still selects the first reel — but only
   * when exactly one item is viewable, which is only true at rest. Mid-snap
   * both reels exceed the 70% threshold and `viewableItems` is not ordered by
   * prominence, so acting on it there re-selects the reel being left.
   */
  const onMomentumScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const index = indexFromOffset(e.nativeEvent.contentOffset.y, viewport);
      const id = clipIdAtIndex(clipIdsRef.current, index);
      if (!id) return;
      // Only a CHANGE OF CLIP is an abandonment. `onMomentumScrollEnd` also
      // fires when momentum settles back onto the reel the user started from,
      // and reporting that would hand `register-skip` a clip the user is still
      // watching — a downward completion sample for a reel nobody left.
      //
      // `activeClipIdRef` mirrors the state so this handler stays dependency-free
      // (the viewport is its only dep, and re-creating it on every active-clip
      // change would churn the FlatList's props mid-scroll).
      if (activeClipIdRef.current !== id) {
        // Fired synchronously, in the same commit that changes the active clip
        // and BEFORE the deferred `loadClip`, because `loadClip` zeroes
        // `currentTime` and moves `playingClipId` — after that the outgoing
        // clip's position is gone and the measurement would be about a clip
        // nobody was watching.
        //
        // `reportUserSkip` takes no arguments on purpose: it reads clipId,
        // position and duration from the store itself, so a caller cannot pass
        // a mismatched clip (the bug that once attributed one clip's watch time
        // to another and scored a perfect 1.0 on a 10 s clip).
        telemetry.reportUserSkip();
        activeClipIdRef.current = id;
      }
      setActiveClipId((prev) => (prev === id ? prev : id));
    },
    [viewport, telemetry],
  );

  const clipIdsRef = useRef<string[]>([]);

  const onViewableItemsChanged = useRef(({ viewableItems }: ViewabilityInfo) => {
    const id = unambiguousViewableId(
      viewableItems.map((v) => (v.item as FeedClip).id),
    );
    if (id) {
      // Viewability selects the FIRST reel on mount, which is not a user action
      // and therefore not an abandonment — so no skip is reported here. The ref
      // is still kept current so `onMomentumScrollEnd` sees the right clip.
      activeClipIdRef.current = id;
      setActiveClipId((prev) => (prev === id ? prev : id));
    }
  }).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 70 }).current;

  /**
   * `onViewableItemsChanged` is the preferred mount signal, but some Android
   * navigation shells do not deliver its initial callback for an already
   * visible tab scene. Without a selected reel, no playback token is minted
   * and the full-card Play target correctly refuses to control a player that
   * has never loaded anything. Select the first loaded reel as a non-user
   * fallback. A later viewability or momentum event still owns subsequent
   * selection, and this path deliberately reports no abandonment.
   */
  const firstClipId = clips[0]?.id ?? null;
  useEffect(() => {
    if (activeClipId !== null || firstClipId === null) return;
    activeClipIdRef.current = firstClipId;
    setActiveClipId(firstClipId);
  }, [activeClipId, firstClipId]);

  // The visible reel is the only one that mints a token.
  const activeIndexById = useMemo(
    () => clips.findIndex((c) => c.id === activeClipId),
    [clips, activeClipId],
  );
  const activeClip = activeIndexById >= 0 ? clips[activeIndexById] : undefined;
  const token = usePlaybackToken(activeClipId);
  /**
   * `usePlaybackToken` returns a new wrapper object on every render. Native
   * status ticks re-render this screen, so using that wrapper itself as a load
   * effect dependency repeatedly called `player.replace()` for the same HLS
   * source. ExoPlayer then restarted the VOD from zero while successfully
   * fetching manifests and segments, which looked like silent playback.
   *
   * Keep the effect keyed to the token facts that change its decision. The
   * refresh callback is separately stable for one clip (`useCallback` in the
   * hook), and belongs only to the processing retry below.
   */
  const stableToken = useMemo<TokenStatus>(
    () => token,
    [token.status, token.clipId, token.status === 'ready' ? token.token : null],
  );

  // Prefetch the NEXT clip so a swipe does not stall on a token mint.
  const nextClipId = useMemo(() => {
    if (activeIndexById < 0) return null;
    return clips[activeIndexById + 1]?.id ?? null;
  }, [clips, activeIndexById]);
  usePrefetchPlaybackToken(nextClipId);

  useEffect(() => {
    if (activeIndexById >= 0) setActiveIndex(activeIndexById);
  }, [activeIndexById, setActiveIndex]);

  /**
   * Map the token lifecycle onto the player.
   *
   * The *decision* lives in `lib/playbackDecision.ts` and is unit-tested; this
   * effect only performs it. Two things are load-bearing about the dependency
   * array and must not be "tidied":
   *
   *  - `clips` is NOT a dependency. The array identity changes on every
   *    refill, so including it re-ran this effect and called `loadClip` again
   *    for the clip already playing — restarting the audio under the user with
   *    no visible cause. `activeClip` is read through a ref instead, so a
   *    refill cannot retrigger a load.
   *
   *  - The generation is read at call time, and `loadClip` is synchronous, so
   *    the "race guard" is really an ordering guarantee: the effect below
   *    always issues loads in order, and a superseded timer is cleared by the
   *    effect's own cleanup.
   */
  const activeClipRef = useRef<FeedClip | undefined>(undefined);
  activeClipRef.current = activeClip;

  useEffect(() => {
    const clip = activeClipRef.current;
    const action = decidePlaybackAction({
      token: stableToken,
      activeClipId,
      activeClipMissing: activeClipId !== null && !clip,
      activeClipHasNoPlaylist: Boolean(activeClipId) && !clip?.hls_playlist_url,
      sinceLastLoadMs: Date.now() - lastLoadAt.current,
    });

    switch (action.kind) {
      case 'none':
        return;

      case 'show':
        setCardStatus(action.status === 'idle' ? 'minting' : action.status);
        if (action.status === 'processing') {
          // 409: HLS is still being encoded. The plan requires a retry, and
          // `usePlaybackToken.refresh()` is the escape hatch for exactly this
          // — without it the function is unreachable API and a clip that
          // finishes encoding 4s after the user swipes onto it shows
          // "Still processing" until they swipe away and back.
          const timer = setTimeout(() => token.refresh(), PROCESSING_RETRY_MS);
          return () => clearTimeout(timer);
        }
        return;

      case 'stop':
        // The 60-cap evicted the clip that was playing. Stop rather than leave
        // audio running for a reel that is no longer on screen.
        pause();
        setCardStatus('idle');
        return;

      case 'load-after': {
        // Stop the outgoing clip NOW. Deferring only the load leaves it
        // audible for the full pause and then severs it mid-word on replace().
        pause();
        const clipForTimer = clip;
        const timer = setTimeout(() => {
          if (!clipForTimer) return;
          lastLoadAt.current = Date.now();
          void loadClip(clipForTimer, action.token);
        }, action.waitMs);
        return () => clearTimeout(timer);
      }

      case 'load': {
        if (!clip) return;
        lastLoadAt.current = Date.now();
        void loadClip(clip, action.token);
        return;
      }

      default:
        return;
    }
  }, [stableToken, activeClipId, setCardStatus, pause, token.refresh]);

  /**
   * Hands-free auto-advance.
   *
   * ## The timer, and why its CLEANUP is the whole safety story
   * `shouldAutoAdvance` is a decision, not a schedule — it returns `waitMs` and
   * leaves the timer to this effect. That split is deliberate: the decision is
   * pure and exhaustively unit-tested in `lib/handsFreeAdvance.ts`, and the only
   * thing this effect adds is the `setTimeout`.
   *
   * The bug the cleanup prevents is the one this effect exists to make
   * impossible: **the pending timer fires after the user has already swiped,
   * and advances a SECOND reel.** The user swipes from a to b, and a
   * millisecond later the timer for a's completion pages them on to c — they
   * never saw b at all. Nothing about the timer is wrong; it is simply acting on
   * a state that has stopped being true.
   *
   * So every state the decision reads is a dependency, and returning
   * `clearTimeout` is what ties the timer's lifetime to that state. The
   * invalidating states are enumerated as a table in
   * `lib/__tests__/handsFreeAdvance.test.ts` ("the invalidation set"), and the
   * cancellation itself is asserted end-to-end in
   * `app/(tabs)/__tests__/index.test.tsx` with fake timers.
   *
   * ## Why `clips` is NOT a dependency here, either
   * Same reason as the load effect above: the array identity changes on every
   * refill, so listing it would cancel and re-schedule a pending advance on
   * every background refill — silently losing the advance and leaving the feed
   * stopped on a last frame. The ids are read through `clipIdsRef`, which is
   * already this screen's mechanism for exactly that (assigned at the end of
   * this render, `:479`), and `clips.length` covers the one change that
   * genuinely invalidates the target.
   */
  useEffect(() => {
    const decision = shouldAutoAdvance({
      playback,
      endedForClipId,
      playingClipId,
      handsFree,
      activeClipId,
      activeIndex: activeIndexById,
      feed: clipIdsRef.current,
      advancedFromClipId: advanceLatchRef.current,
    });

    if (decision.kind !== 'advance') return;

    const timer = setTimeout(() => {
      // The latch is written when the timer FIRES, not when it is scheduled, and
      // that ordering is the answer to "can two renders in the same window both
      // schedule one?". They cannot fire twice either way — the second render's
      // cleanup clears the first timer — but writing the latch here means a
      // re-render CANCELS and RE-SCHEDULES the advance instead of consuming the
      // one budget and dropping it. A lost advance freezes the feed; a double
      // one skips a reel, and the freeze is the worse of the two.
      advanceLatchRef.current = decision.latch;
      // Reported BEFORE the scroll, not after: `loadClip` zeroes `currentTime`
      // and moves `playingClipId`, so the outgoing clip's real position only
      // exists at this instant. `reportAutoAdvance` reads the store itself, so
      // passing ids through is optional; `onAdvance` is the test-only override
      // and gets the full shape.
      telemetry.reportAutoAdvance();
      onAdvanceRef.current?.({
        fromClipId: decision.fromClipId,
        toClipId: decision.toClipId,
        userInitiated: false,
      });
      // `getItemLayout` is supplied, so `scrollToIndex` works; if the target
      // cell is not measured yet RN calls `onScrollToIndexFailed`, which the
      // screen already handles above. There is one handler, not two.
      listRef.current?.scrollToIndex({ index: decision.toIndex, animated: true });
    }, decision.waitMs);

    return () => clearTimeout(timer);
  }, [
    playback,
    endedForClipId,
    playingClipId,
    handsFree,
    activeClipId,
    activeIndexById,
    clips.length,
  ]);

  /**
   * The buffering timeout: evict the token, re-mint, retry the load ONCE.
   *
   * An expired or rejected HLS token almost never produces an error — iOS
   * **stalls** rather than failing the item, so the card shows a spinner for
   * ever with `error: null` and nothing in the app times it out
   * (`03-handoff.md` §4). `lib/handsFreeAdvance.ts` holds the whole policy
   * (the 12 s threshold, the continuous-stall measurement, the once-only latch
   * and the rights-vs-token classification); this effect only feeds it,
   * schedules it and performs it.
   *
   * ## THE TIMER IS LOAD-BEARING, not decoration
   * An effect body runs when a dependency CHANGES, and a stall changes nothing:
   * `playback` is stably `'buffering'` for as long as the item is stalled, and
   * the 2 Hz `currentTime` tick is a field this screen does not subscribe to. An
   * effect that merely re-decided per render would therefore re-decide exactly
   * once, at the moment buffering began, and never again — so the retry would
   * never fire and the permanent spinner would stay permanent.
   *
   * ## `refresh()` IS evict + re-mint + retry, already
   * `usePlaybackToken`'s existing escape hatch: it evicts the cached token and
   * bumps a nonce, which re-runs the load effect above and issues a fresh
   * `loadClip` with the new token. So one call covers all three, and no
   * eviction path was added next to the one the 409-processing timer already
   * uses. **`usePlaybackToken.ts` was not modified**; it did not need to be.
   *
   * Idempotence comes from `retryStalledClip` writing `retried` into the watch
   * it hands back: `refresh()` bumps a nonce unconditionally, so without that
   * latch every re-mint would re-arm the timer — a loop, and the loop is the one
   * outcome this feature is forbidden to build.
   */
  const bufferWatchRef = useRef(initialBufferWatch());
  useEffect(() => {
    const nowMs = Date.now();
    const watch = observeBuffer(bufferWatchRef.current, {
      clipId: playingClipId,
      buffering: playback === 'buffering',
      nowMs,
    });
    bufferWatchRef.current = watch;

    const attempt = () => {
      const outcome = retryStalledClip({
        watch: bufferWatchRef.current,
        playback,
        tokenStatus: token.clipId === activeClipId ? token.status : null,
        nowMs: Date.now(),
        refresh: token.refresh,
      });
      bufferWatchRef.current = outcome.watch;
    };

    const delayMs = bufferRetryDelayMs(watch, nowMs);
    if (delayMs === 0) {
      // Already past the deadline, or nothing to measure. Decide now rather
      // than scheduling a `0 ms` timer, so the outcome is observable in the
      // same commit.
      attempt();
      return;
    }

    // A 403 short-circuits the DECISION, not the timer: scheduling and then
    // refusing is one wasted timer per clip, which is cheaper than duplicating
    // the rights classification here and letting the two drift.
    const timer = setTimeout(attempt, delayMs);
    return () => clearTimeout(timer);
  }, [playback, playingClipId, token, activeClipId]);

  const renderItem = useCallback(
    ({ item }: { item: FeedClip }) => (
      <ReelCard
        clip={item}
        active={item.id === activeClipId}
        cardStatus={cardStatus}
        playback={playback}
        durationMs={item.duration_ms}
        height={viewport}
        onOpenComments={() => setCommentClip(item)}
        onOpenShare={() => setShareClip(item)}
      />
    ),
    [activeClipId, cardStatus, playback, viewport],
  );

  // The momentum handler reads the id list through a ref so it is not
  // re-created on every refill (a new callback identity on a scrolling
  // VirtualizedList is wasteful, and the ids are already in the closure of the
  // render that produced them).
  clipIdsRef.current = clips.map((c) => c.id);

  if (feed.loading && clips.length === 0) {
    return (
      <View style={[styles.fill, { backgroundColor: surface.base }]}>
        <NetworkBanner status={backend} />
        <View style={styles.center}>
          <Spinner label="Loading feed" />
        </View>
      </View>
    );
  }

  return (
    <View
      style={[styles.fill, { backgroundColor: surface.base }]}
      onLayout={onListLayout}
    >
      <NetworkBanner status={backend} />
      <FlatList
        ref={listRef}
        data={clips}
        keyExtractor={(c) => c.id}
        renderItem={renderItem}
        pagingEnabled
        getItemLayout={getItemLayout}
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        onMomentumScrollEnd={onMomentumScrollEnd}
        // Keeps the buffer shallow: these are full-bleed reels, and holding
        // dozens of them mounted is what made the old feed stutter.
        initialNumToRender={2}
        windowSize={3}
        removeClippedSubviews
        onScrollToIndexFailed={onScrollToIndexFailed}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={typography.title}>Nothing to play yet</Text>
            <Text style={[typography.bodySecondary, styles.emptyBody]}>
              {feed.coolingDown
                ? 'Finding more for you…'
                : feed.error
                  ? // A transport failure is not a statement about content,
                    // and there is no pull-to-refresh on this list, so the
                    // copy has to offer the action that actually exists.
                    "We couldn't load the feed."
                  : 'Upload a clip to get started.'}
            </Text>
            {feed.error ? (
              <Button label="Try again" onPress={feed.refresh} style={styles.retry} />
            ) : null}
          </View>
        }
      />
      <ShareModal
        visible={shareClip !== null}
        clipId={shareClip?.id ?? ''}
        title={shareClip?.title}
        creatorName={shareClip?.creator_name}
        isShareable
        onClose={() => setShareClip(null)}
      />
      <CommentSheet
        visible={commentClip !== null}
        clipId={commentClip?.id ?? ''}
        viewerId={viewerId}
        onClose={() => setCommentClip(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.stack },
  emptyBody: { textAlign: 'center', marginTop: spacing.gutter },
  retry: { marginTop: spacing.gutter },
});
