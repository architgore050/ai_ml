import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View, type ViewToken } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Spinner } from '../../src/components/ui/Button';
import { NetworkBanner } from '../../src/components/NetworkBanner';
import { useBackendStatus } from '../../src/hooks/useBackendStatus';
import { useFeedBuffer, useSuggestionsFallback } from '../../src/hooks/useFeedBuffer';
import { usePlaybackToken, usePrefetchPlaybackToken } from '../../src/hooks/usePlaybackToken';
import { loadClip, msToSeconds, usePlayerStore } from '../../src/store/player';
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
  const fallback = useSuggestionsFallback('music', feed.clips.length === 0 && !feed.loading);

  const clips = feed.clips.length > 0 ? feed.clips : fallback.clips;
  const activeIndex = usePlayerStore((s) => s.activeIndex);
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

  // Map the token lifecycle onto the player, with the generation guard so a
  // slow load cannot win a race against a faster later one.
  useEffect(() => {
    if (token.status === 'processing') {
      // HLS is not produced yet. Poll-ish: the card shows a spinner and the
      // user swipes on. Retrying is the feed's job, not this effect's.
      setStatus('processing');
      return;
    }
    if (token.status === 'unavailable' || token.status === 'gone') {
      setStatus('unavailable');
      return;
    }
    if (token.status !== 'ready' || !activeClipId) {
      setStatus(token.status === 'minting' ? 'minting' : 'idle');
      return;
    }

    const clip = clips.find((c) => c.id === activeClipId);
    if (!clip) return;

    const now = Date.now();
    const sinceLast = now - lastLoadAt.current;
    if (sinceLast < INTER_REEL_PAUSE_MS) {
      const timer = setTimeout(() => {
        lastLoadAt.current = Date.now();
        void loadClip(clip, token.token, usePlayerStore.getState().loadGeneration);
      }, INTER_REEL_PAUSE_MS - sinceLast);
      return () => clearTimeout(timer);
    }

    lastLoadAt.current = now;
    void loadClip(clip, token.token, usePlayerStore.getState().loadGeneration);
  }, [token.status, 'token' in token ? token.token : null, activeClipId, clips, setStatus]);

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
