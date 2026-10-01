import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { toggleFollow } from '../../src/api/endpoints/social';
import type { FeedClip } from '../../src/api/schema';
import { NetworkBanner } from '../../src/components/NetworkBanner';
import { confirmFollow, failFollow, hydrateFollowState, pressFollow, type FollowState } from '../../src/lib/followState';
import { useAuthStore } from '../../src/store/auth';
import { accent, border, content, spacing, surface } from '../../src/design/tokens';
import { typography } from '../../src/design/typography';
import { useBackendStatus } from '../../src/hooks/useBackendStatus';
import { usePublicProfile } from '../../src/hooks/usePublicProfile';

function profileIdFromParam(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string') return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Public account route. It deliberately does not reuse `/profile/me/`. */
export default function PublicProfileScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const userId = profileIdFromParam(params.id);
  const viewerId = useAuthStore((state) => state.user?.id ?? null);
  const backend = useBackendStatus();
  const state = usePublicProfile(userId);
  const [follow, setFollow] = useState<FollowState>(() => hydrateFollowState({ viewerId }));
  const followRef = useRef(follow);

  const replaceFollow = (next: FollowState) => {
    followRef.current = next;
    setFollow(next);
  };

  // The server response is the only valid initial toggle direction. Until it
  // exists, this deliberately leaves the button disabled rather than guessing.
  useEffect(() => {
    replaceFollow(hydrateFollowState({
      clip: state.profile ? { creator_id: state.profile.id } : null,
      viewerId,
      isFollowing: state.profile?.is_following,
    }));
  }, [state.profile?.id, state.profile?.is_following, viewerId]);

  const onFollow = () => {
    const action = pressFollow(followRef.current);
    replaceFollow(action.state);
    if (action.kind !== 'sent' || action.state.userId === null) return;

    void toggleFollow(action.state.userId).then(
      (result) => replaceFollow(confirmFollow(followRef.current, action.requestId, result.status)),
      (err: unknown) => replaceFollow(failFollow(followRef.current, action.requestId, err)),
    );
  };

  if (state.loading) {
    return <View style={styles.screen}><NetworkBanner status={backend} /><View style={styles.center}><ActivityIndicator color={accent.base} /></View></View>;
  }
  if (state.error && !state.profile) {
    return <View style={styles.screen}><NetworkBanner status={backend} /><View style={styles.center}><Text style={styles.body}>{state.error}</Text><Retry onPress={state.refresh} /></View></View>;
  }
  if (!state.profile) {
    return <View style={styles.screen}><NetworkBanner status={backend} /><View style={styles.center}><Text style={styles.body}>Profile unavailable.</Text></View></View>;
  }

  const label = follow.isFollowing ? 'Following' : 'Follow';
  const followEnabled = follow.isFollowing !== null && !follow.pending && follow.userId !== viewerId;
  return (
    <View style={styles.screen}>
      <NetworkBanner status={backend} />
      <FlatList
        data={state.clips}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={state.refresh} tintColor={accent.base} />}
        onEndReached={state.loadMore}
        onEndReachedThreshold={0.6}
        ListHeaderComponent={<View style={styles.header}>
          <Text style={styles.username}>{state.profile.username}</Text>
          <View style={styles.stats}>
            <Stat label="Followers" value={state.profile.followers_count} />
            <Stat label="Following" value={state.profile.following_count} />
            <Stat label="Uploads" value={state.profile.uploads_count} />
          </View>
          {follow.userId !== viewerId ? <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={!followEnabled} onPress={onFollow} style={[styles.follow, !followEnabled && styles.disabled]}>
            {follow.pending ? <ActivityIndicator size="small" color={surface.base} /> : <Text style={styles.followText}>{label}</Text>}
          </Pressable> : null}
          {follow.error ? <Text style={styles.error}>{follow.error}</Text> : null}
          <Text style={styles.section}>Clips</Text>
        </View>}
        ListEmptyComponent={<Text style={styles.body}>No public clips yet.</Text>}
        ListFooterComponent={state.loadingMore ? <ActivityIndicator color={accent.base} /> : null}
        renderItem={({ item }: { item: FeedClip }) => <View style={styles.clip}><Text style={styles.clipTitle} numberOfLines={2}>{item.title}</Text><Text style={typography.microLabel}>{item.creator_name}</Text></View>}
      />
    </View>
  );
}

function Retry({ onPress }: { onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel="Retry public profile" onPress={onPress} style={styles.retry}><Text style={typography.label}>Retry</Text></Pressable>;
}
function Stat({ label, value }: { label: string; value: number }) {
  return <View><Text style={styles.statValue}>{value}</Text><Text style={typography.microLabel}>{label}</Text></View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: surface.base },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.stack },
  list: { padding: spacing.stack, gap: spacing.gutter },
  header: { gap: spacing.stack, paddingBottom: spacing.stack },
  username: { ...typography.page, color: content.primary },
  stats: { flexDirection: 'row', gap: spacing.stack }, statValue: { ...typography.label, color: content.primary },
  section: { ...typography.label, color: content.primary }, body: { ...typography.bodySecondary, color: content.tertiary, textAlign: 'center' },
  follow: { alignSelf: 'flex-start', minWidth: 108, alignItems: 'center', borderRadius: 999, backgroundColor: accent.base, paddingHorizontal: spacing.stack, paddingVertical: spacing.gutter },
  followText: { ...typography.label, color: surface.base }, disabled: { opacity: 0.55 }, error: { ...typography.bodySecondary, color: content.tertiary },
  clip: { borderWidth: 1, borderColor: border.default, borderRadius: 12, padding: spacing.stack, gap: 4 }, clipTitle: { ...typography.label, color: content.primary },
  retry: { marginTop: spacing.stack, borderWidth: 1, borderColor: accent.base, borderRadius: 999, paddingHorizontal: spacing.stack, paddingVertical: spacing.gutter },
});
