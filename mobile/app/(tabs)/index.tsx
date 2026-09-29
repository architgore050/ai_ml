import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View, type ViewToken } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Spinner } from '../../src/components/ui/Button';
import { NetworkBanner } from '../../src/components/NetworkBanner';
import { useBackendStatus } from '../../src/hooks/useBackendStatus';
import { useFeedBuffer, useSuggestionsFallback } from '../../src/hooks/useFeedBuffer';
import { usePlaybackToken, usePrefetchPlaybackToken } from '../../src/hooks/usePlaybackToken';
import { loadClip, msToSeconds, pause, usePlayerStore } from '../../src/store/player';
import { decidePlaybackAction } from '../../src/lib/playbackDecision';
import { categoryColor, categoryLabel } from '../../src/design/categories';
import { spacing, surface } from '../../src/design/tokens';
import { typography } from '../../src/design/typography';
import type { FeedClip } from '../../src/api/schema';

/**
 * The feed: vertical snap reels over ONE app-wide player.
 *
 * ## What this phase deliberately does NOT do
 * No likes, comments, shares, follows, or telemetry. `registerSkip` in
 * particular is Phase 3, and its absence is deliberate rather than an
 * omission: the old app fired a skip when playback reached the end, which
 * corrupted `avg_completion_rate` and therefore the recommender (defect 2).
 * A wrong measurement is worse than no measurement, so nothing is reported
 * until the completion guard lands with it.
 *
 * ## Autoplay
 * A reel plays when it is at least 70% visible, which stops a reel that is
 * merely peeking from playing under the one you are actually watching. There
 * is a 1000 ms pause between reels so a flick-scroll does not machine-gun
 * through token mints.
 */

const VISIBILITY_THRESHOLD = 0.7;
const INTER_REEL_PAUSE_MS = 1000;

type ViewabilityInfo = {
  viewableItems: ViewToken<FeedClip>[];
  changed: ViewToken<FeedClip>[];
};

export default function Screen() {
  const backend = useBackendStatus();
  const insets = useSafeAreaInsets();
  const feed = useFeedBuffer();
  // `all` is now honoured server-side as "no category filter"; it used to be
  // matched literally against a free-text column and matched nothing, which is
  // why this hardcoded `music`. A cold start could only ever show one category.
  const fallback = useSuggestionsFallback('all', feed.clips.length === 0 && !feed.loading);

  const clips = feed.clips.length > 0 ? feed.clips : fallback.clips;
  const setActiveIndex = usePlayerStore((s) => s.setActiveIndex);
  const setStatus = usePlayerStore((s) => s.setStatus);
  const status = usePlayerStore((s) => s.status);

  /** Guards the inter-reel pause. */
  const lastLoadAt = useRef(0);
  const [activeClipId, setActiveClipId] = useState<string | null>(null);

  const onViewableItemsChanged = useRef(({ viewableItems }: ViewabilityInfo) => {
    const first = viewableItems[0];
    if (!first) return;
    const id = (first.item as FeedClip).id;
    setActiveClipId((prev) => (prev === id ? prev : id));
  }).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 70 }).current;

  // The visible reel is the only one that mints a token.
  const activeIndexById = useMemo(
    () => clips.findIndex((c) => c.id === activeClipId),
    [clips, activeClipId],
  );
  const activeClip = activeIndexById >= 0 ? clips[activeIndexById] : undefined;
  const token = usePlaybackToken(activeClipId);

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
      token,
      activeClipId,
      activeClipMissing: activeClipId !== null && !clip,
      activeClipHasNoPlaylist: Boolean(activeClipId) && !clip?.hls_playlist_url,
      sinceLastLoadMs: Date.now() - lastLoadAt.current,
    });

    switch (action.kind) {
      case 'none':
        return;

      case 'show':
        setStatus(action.status === 'idle' ? 'minting' : action.status);
        return;

      case 'stop':
        // The 60-cap evicted the clip that was playing. Stop rather than leave
        // audio running for a reel that is no longer on screen.
        pause();
        setStatus('idle');
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
  }, [token, activeClipId, setStatus, pause]);

  const renderItem = useCallback(
    ({ item }: { item: FeedClip }) => (
      <ReelCard
        clip={item}
        active={item.id === activeClipId}
        status={status}
        durationMs={item.duration_ms}
      />
    ),
    [activeClipId, status],
  );

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
    <View style={[styles.fill, { backgroundColor: surface.base }]}>
      <NetworkBanner status={backend} />
      <FlatList
        data={clips}
        keyExtractor={(c) => c.id}
        renderItem={renderItem}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        // Keeps the buffer shallow: these are full-bleed reels, and holding
        // dozens of them mounted is what made the old feed stutter.
        initialNumToRender={2}
        windowSize={3}
        removeClippedSubviews
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={typography.title}>Nothing to play yet</Text>
            <Text style={[typography.bodySecondary, styles.emptyBody]}>
              {feed.coolingDown
                ? 'Finding more for you…'
                : 'Upload a clip, or pull to refresh once the feed has refilled.'}
            </Text>
          </View>
        }
        ListFooterComponent={<View style={{ height: insets.bottom + spacing.stack }} />}
      />
    </View>
  );
}

/**
 * One full-bleed reel.
 *
 * Visual design (cover art, ambient orbs, the 40-bar waveform, the action
 * cluster) is plan §13 and arrives with the Phase 2 polish pass. This card
 * carries what playback actually needs: identity, duration, category, and the
 * four terminal states, because those are what make the transport legible when
 * it fails.
 */
function ReelCard({
  clip,
  active,
  status,
  durationMs,
}: {
  clip: FeedClip;
  active: boolean;
  status: string;
  durationMs?: number;
}) {
  const tint = categoryColor(clip.category);
  const seconds = durationMs ? Math.round(msToSeconds(durationMs)) : null;

  return (
    <View style={styles.reel}>
      <View style={[styles.reelTint, { backgroundColor: tint, opacity: 0.08 }]} />

      <View style={styles.reelBody}>
        <Text style={typography.microLabel}>{active ? 'Now playing' : clip.creator_name}</Text>
        <Text style={[typography.page, styles.reelTitle]} numberOfLines={2}>
          {clip.title}
        </Text>

        <View style={styles.metaRow}>
          {clip.category ? (
            <View style={[styles.chip, { borderColor: tint }]}>
              <Text style={[typography.microLabel, { color: tint }]}>
                {categoryLabel(clip.category)}
              </Text>
            </View>
          ) : null}
          {seconds ? <Text style={typography.count}>{seconds}s</Text> : null}
        </View>

        {/* tags come from KeyBERT over the Whisper transcript, so they are a
            real content signal rather than the uploader's chosen category. */}
        {clip.tags && clip.tags.length > 0 ? (
          <Text style={[typography.bodySecondary, styles.tags]} numberOfLines={2}>
            {clip.tags.join(' · ')}
          </Text>
        ) : null}

        {active ? <CardStatus status={status} /> : null}
      </View>
    </View>
  );
}

/** The four states the plan's error mapping requires be visually distinct. */
function CardStatus({ status }: { status: string }) {
  if (status === 'minting' || status === 'loading') {
    return (
      <View style={styles.statusBox}>
        <Spinner />
      </View>
    );
  }
  if (status === 'processing') {
    return (
      <View style={styles.statusBox}>
        <Text style={typography.label}>Still processing — this clip is being encoded</Text>
      </View>
    );
  }
  if (status === 'unavailable') {
    return (
      <View style={styles.statusBox}>
        {/* SECURITY: one message for BOTH 403 causes (unmoderated and
            licence-restricted). Distinguishing them tells a caller holding
            only a UUID something about moderation or licensing state. */}
        <Text style={typography.label}>This clip is no longer available</Text>
      </View>
    );
  }
  if (status === 'error') {
    return (
      <View style={styles.statusBox}>
        <Text style={typography.label}>Could not play this clip</Text>
      </View>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.stack },
  emptyBody: { textAlign: 'center', marginTop: spacing.gutter },
  reel: { flex: 1, justifyContent: 'flex-end' },
  // RN 0.86 exposes `absoluteFill` only; `absoluteFillObject` is gone.
  reelTint: { ...StyleSheet.absoluteFill, opacity: 0.08 },
  reelBody: { padding: spacing.stack, paddingBottom: spacing.stack * 2, gap: spacing.gutter },
  reelTitle: { marginTop: spacing.marginMobile },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.gutter },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: spacing.gutter,
    paddingVertical: spacing.marginMobile / 3,
  },
  tags: { opacity: 0.7 },
  statusBox: { marginTop: spacing.marginMobile },
});
