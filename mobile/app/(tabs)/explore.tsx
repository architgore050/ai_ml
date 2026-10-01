import React, { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Pause, Play } from 'lucide-react-native';

import type { FeedClip } from '../../src/api/schema';
import { NetworkBanner } from '../../src/components/NetworkBanner';
import { ALL_CATEGORIES, categoryLabel } from '../../src/design/categories';
import { accent, border, content, spacing, surface } from '../../src/design/tokens';
import { typography } from '../../src/design/typography';
import { useBackendStatus } from '../../src/hooks/useBackendStatus';
import { useSuggestions } from '../../src/hooks/useSuggestions';
import { mintPlaybackToken } from '../../src/api/endpoints/feed';
import { loadClip, pause, resume, usePlayerStore } from '../../src/store/player';

const DISCOVER_CATEGORIES = ['all', ...ALL_CATEGORIES] as const;

/**
 * Discover uses `/suggestions/`, not the personalised `/feed/` queue. The
 * former is cursor-paginated and safe to refresh; the latter consumes rows on
 * every request and therefore belongs exclusively to the feed tab.
 */
export default function Screen() {
  const backend = useBackendStatus();
  const [category, setCategory] = useState<string>('all');
  const suggestions = useSuggestions(category);
  const [pendingClipId, setPendingClipId] = useState<string | null>(null);
  const playingClipId = usePlayerStore((state) => state.playingClipId);
  const playback = usePlayerStore((state) => state.playback);
  const setQueue = usePlayerStore((state) => state.setQueue);
  const setActiveIndex = usePlayerStore((state) => state.setActiveIndex);
  const setCardStatus = usePlayerStore((state) => state.setCardStatus);

  const playClip = useCallback(async (clip: FeedClip) => {
    if (pendingClipId) return;
    if (playingClipId === clip.id) {
      if (playback === 'playing') pause();
      else resume();
      return;
    }

    setPendingClipId(clip.id);
    setCardStatus('minting');
    // PlayerHost reads the store queue for lock-screen metadata. A Discover
    // selection must therefore become the one-item queue before loading.
    setQueue([clip]);
    setActiveIndex(0);
    try {
      const { token } = await mintPlaybackToken(clip.id);
      await loadClip(clip, token);
    } catch (cause) {
      setCardStatus('error', cause instanceof Error ? cause.message : 'Could not start playback.');
    } finally {
      setPendingClipId(null);
    }
  }, [pendingClipId, playback, playingClipId, setActiveIndex, setCardStatus, setQueue]);

  return (
    <View style={styles.screen}>
      <NetworkBanner status={backend} />
      <Text style={styles.title}>Discover</Text>
      <FlatList
        horizontal
        data={DISCOVER_CATEGORIES}
        keyExtractor={(item) => item}
        contentContainerStyle={styles.pills}
        showsHorizontalScrollIndicator={false}
        renderItem={({ item }) => {
          const selected = item === category;
          const label = item === 'all' ? 'All' : categoryLabel(item);
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={label}
              onPress={() => setCategory(item)}
              style={[styles.pill, selected && styles.pillSelected]}
            >
              <Text style={[typography.label, selected && styles.pillLabelSelected]}>{label}</Text>
            </Pressable>
          );
        }}
      />
      {suggestions.loading ? (
        <View style={styles.center}><ActivityIndicator color={accent.base} /></View>
      ) : suggestions.error ? (
        <View style={styles.center}>
          <Text style={styles.body}>{suggestions.error}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry Discover" onPress={suggestions.refresh} style={styles.retry}>
            <Text style={typography.label}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          testID="discover-list"
          data={suggestions.clips}
          keyExtractor={(item) => item.id}
          renderItem={({ item }: { item: FeedClip }) => (
            <DiscoverCard
              clip={item}
              active={playingClipId === item.id}
              playing={playingClipId === item.id && playback === 'playing'}
              loading={pendingClipId === item.id}
              onPress={() => void playClip(item)}
            />
          )}
          contentContainerStyle={suggestions.clips.length ? styles.list : styles.center}
          refreshControl={<RefreshControl refreshing={suggestions.refreshing} onRefresh={suggestions.refresh} tintColor={accent.base} />}
          onEndReached={suggestions.loadMore}
          onEndReachedThreshold={0.6}
          ListEmptyComponent={<Text style={styles.body}>No clips in this category yet.</Text>}
          ListFooterComponent={suggestions.loadingMore ? <ActivityIndicator color={accent.base} /> : null}
        />
      )}
    </View>
  );
}

function DiscoverCard({
  clip,
  active,
  playing,
  loading,
  onPress,
}: {
  clip: FeedClip;
  active: boolean;
  playing: boolean;
  loading: boolean;
  onPress: () => void;
}) {
  return (
    <View style={[styles.card, active && styles.cardActive]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${playing ? 'Pause' : 'Play'} ${clip.title}`}
        accessibilityState={{ busy: loading }}
        disabled={loading}
        onPress={onPress}
        style={[styles.playButton, active && styles.playButtonActive]}
      >
        {loading ? <ActivityIndicator color={surface.base} /> : playing ? <Pause size={22} color={surface.base} fill={surface.base} /> : <Play size={22} color={surface.base} fill={surface.base} />}
      </Pressable>
      <View style={styles.cardCopy}>
        <Text style={typography.microLabel}>{clip.creator_name}</Text>
        <Text style={styles.cardTitle} numberOfLines={2}>{clip.title}</Text>
        <Text style={typography.bodySecondary}>{categoryLabel(clip.category)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: surface.base },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.stack, gap: spacing.gutter },
  title: { ...typography.page, color: content.primary, paddingHorizontal: spacing.stack, paddingTop: spacing.stack },
  body: { ...typography.bodySecondary, color: content.tertiary, textAlign: 'center' },
  pills: { gap: spacing.gutter, paddingHorizontal: spacing.stack, paddingVertical: spacing.gutter },
  pill: { borderWidth: 1, borderColor: border.default, borderRadius: 999, paddingHorizontal: spacing.stack, paddingVertical: spacing.gutter },
  pillSelected: { backgroundColor: accent.base, borderColor: accent.base },
  pillLabelSelected: { color: surface.base },
  list: { padding: spacing.stack, gap: spacing.gutter },
  card: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: border.default, borderRadius: 16, padding: spacing.stack, gap: spacing.gutter },
  cardActive: { borderColor: accent.base },
  cardCopy: { flex: 1, minWidth: 0, gap: 4 },
  // Fixed square geometry keeps the icon's circular silhouette intact at every
  // device scale and gives Discover a visible, independently reachable action.
  playButton: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: accent.base, flexShrink: 0 },
  playButtonActive: { backgroundColor: accent.base },
  cardTitle: { ...typography.label, color: content.primary },
  retry: { borderWidth: 1, borderColor: accent.base, borderRadius: 999, paddingHorizontal: spacing.stack, paddingVertical: spacing.gutter },
});
