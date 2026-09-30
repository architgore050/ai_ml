import React, { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { markShareRead, type ShareInboxItem } from '../../src/api/endpoints/share';
import { NetworkBanner } from '../../src/components/NetworkBanner';
import { accent, border, content, spacing, surface } from '../../src/design/tokens';
import { typography } from '../../src/design/typography';
import { useBackendStatus } from '../../src/hooks/useBackendStatus';
import { useShareInbox } from '../../src/hooks/useShareInbox';

/** Received shares are read from a bare array and refreshed every 30 seconds. */
export default function Screen() {
  const backend = useBackendStatus();
  const inbox = useShareInbox();
  const [markingId, setMarkingId] = useState<string | null>(null);

  const markRead = async (share: ShareInboxItem) => {
    if (share.is_read || markingId !== null) return;
    setMarkingId(share.id);
    try {
      await markShareRead(share.id);
      // The endpoint's 204 is deliberately non-disclosing. Re-read the inbox
      // rather than fabricating success from a status that also covers a row
      // deleted elsewhere.
      inbox.refresh();
    } finally {
      setMarkingId(null);
    }
  };

  return (
    <View style={styles.screen}>
      <NetworkBanner status={backend} />
      <Text style={styles.title}>Inbox</Text>
      {inbox.loading ? (
        <View style={styles.center}><ActivityIndicator color={accent.base} /></View>
      ) : inbox.error ? (
        <View style={styles.center}>
          <Text style={styles.body}>{inbox.error}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry inbox" onPress={inbox.refresh} style={styles.retry}>
            <Text style={typography.label}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={inbox.shares}
          keyExtractor={(item) => item.id}
          contentContainerStyle={inbox.shares.length ? styles.list : styles.center}
          refreshControl={<RefreshControl refreshing={inbox.refreshing} onRefresh={inbox.refresh} tintColor={accent.base} />}
          ListEmptyComponent={<Text style={styles.body}>No shared clips yet.</Text>}
          renderItem={({ item }) => (
            <View style={[styles.card, !item.is_read && styles.unread]}>
              <Text style={typography.microLabel}>Shared by {item.sender_name}</Text>
              <Text style={styles.cardTitle} numberOfLines={2}>{item.clip_title}</Text>
              <Text style={typography.bodySecondary}>{item.clip.creator_name}</Text>
              {!item.is_read ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Mark ${item.clip_title} as read`}
                  disabled={markingId !== null}
                  onPress={() => void markRead(item)}
                  style={styles.readButton}
                >
                  <Text style={typography.label}>{markingId === item.id ? 'Marking…' : 'Mark read'}</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: surface.base },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.stack, gap: spacing.gutter },
  title: { ...typography.page, color: content.primary, paddingHorizontal: spacing.stack, paddingTop: spacing.stack },
  body: { ...typography.bodySecondary, color: content.tertiary, textAlign: 'center' },
  list: { padding: spacing.stack, gap: spacing.gutter },
  card: { borderWidth: 1, borderColor: border.default, borderRadius: 12, padding: spacing.stack, gap: 4 },
  unread: { borderColor: accent.base },
  cardTitle: { ...typography.label, color: content.primary },
  readButton: { alignSelf: 'flex-start', marginTop: spacing.gutter, borderWidth: 1, borderColor: accent.base, borderRadius: 999, paddingHorizontal: spacing.stack, paddingVertical: spacing.gutter },
  retry: { borderWidth: 1, borderColor: accent.base, borderRadius: 999, paddingHorizontal: spacing.stack, paddingVertical: spacing.gutter },
});
