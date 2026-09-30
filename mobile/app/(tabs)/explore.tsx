import React, { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import type { FeedClip } from '../../src/api/schema';
import { NetworkBanner } from '../../src/components/NetworkBanner';
import { ALL_CATEGORIES, categoryLabel } from '../../src/design/categories';
import { accent, border, content, spacing, surface } from '../../src/design/tokens';
import { typography } from '../../src/design/typography';
import { useBackendStatus } from '../../src/hooks/useBackendStatus';
import { useSuggestions } from '../../src/hooks/useSuggestions';

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
          renderItem={({ item }: { item: FeedClip }) => <DiscoverCard clip={item} />}
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

function DiscoverCard({ clip }: { clip: FeedClip }) {
  return (
    <View style={styles.card}>
      <Text style={typography.microLabel}>{clip.creator_name}</Text>
      <Text style={styles.cardTitle} numberOfLines={2}>{clip.title}</Text>
      <Text style={typography.bodySecondary}>{categoryLabel(clip.category)}</Text>
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
  card: { borderWidth: 1, borderColor: border.default, borderRadius: 12, padding: spacing.stack, gap: 4 },
  cardTitle: { ...typography.label, color: content.primary },
  retry: { borderWidth: 1, borderColor: accent.base, borderRadius: 999, paddingHorizontal: spacing.stack, paddingVertical: spacing.gutter },
});
