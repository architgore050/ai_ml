import React, { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';

import type { FeedClip } from '../../src/api/schema';
import { NetworkBanner } from '../../src/components/NetworkBanner';
import { accent, border, content, spacing, surface } from '../../src/design/tokens';
import { typography } from '../../src/design/typography';
import { useBackendStatus } from '../../src/hooks/useBackendStatus';
import { useOwnProfile } from '../../src/hooks/useOwnProfile';

/** Own profile only: it is the endpoint that legitimately includes liked clips. */
export default function Screen() {
  const backend = useBackendStatus();
  const state = useOwnProfile();
  const [avatarBusy, setAvatarBusy] = useState(false);

  const chooseAvatar = async () => {
    if (avatarBusy) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Photo permission needed', 'Allow photo access to choose a profile picture.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.9,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;
    if ((asset.fileSize ?? 0) > 5 * 1024 * 1024) {
      Alert.alert('Image is too large', 'Choose an image smaller than 5 MB.');
      return;
    }
    setAvatarBusy(true);
    try {
      await state.updateAvatar(asset);
    } catch (cause) {
      Alert.alert('Could not update picture', cause instanceof Error ? cause.message : 'Try again.');
    } finally {
      setAvatarBusy(false);
    }
  };

  if (state.loading) {
    return <View style={styles.screen}><NetworkBanner status={backend} /><View style={styles.center}><ActivityIndicator color={accent.base} /></View></View>;
  }
  if (state.error || !state.profile) {
    return (
      <View style={styles.screen}>
        <NetworkBanner status={backend} />
        <View style={styles.center}>
          <Text style={styles.body}>{state.error ?? 'Could not load your profile.'}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry profile" onPress={state.refresh} style={styles.retry}>
            <Text style={typography.label}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const { profile } = state;
  return (
    <View style={styles.screen}>
      <NetworkBanner status={backend} />
      <FlatList
        data={profile.liked_clips ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={state.refresh} tintColor={accent.base} />}
        ListHeaderComponent={
          <View style={styles.header}>
            <Pressable accessibilityRole="button" accessibilityLabel="Change profile picture" accessibilityState={{ busy: avatarBusy }} onPress={() => void chooseAvatar()} disabled={avatarBusy} style={styles.avatarButton}>
              {profile.profile_picture ? <Image source={{ uri: profile.profile_picture }} style={styles.avatar} /> : <View style={styles.avatarFallback}><Text style={styles.avatarText}>{profile.username.slice(0, 1).toUpperCase()}</Text></View>}
              <Text style={styles.avatarAction}>{avatarBusy ? 'Uploading…' : 'Change picture'}</Text>
            </Pressable>
            <Text style={styles.username}>{profile.username}</Text>
            <View style={styles.stats}>
              <Stat label="Followers" value={profile.followers_count} />
              <Stat label="Following" value={profile.following_count} />
              <Stat label="Uploads" value={profile.uploads_count} />
            </View>
            <Text style={styles.section}>Liked clips</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Open settings" onPress={() => router.push('/settings' as never)} style={styles.settings}><Text style={typography.label}>Settings</Text></Pressable>
          </View>
        }
        ListEmptyComponent={<Text style={styles.body}>No liked clips yet.</Text>}
        renderItem={({ item }: { item: FeedClip }) => (
          <View style={styles.clip}>
            <Text style={typography.microLabel}>{item.creator_name}</Text>
            <Text style={styles.clipTitle} numberOfLines={2}>{item.title}</Text>
          </View>
        )}
      />
    </View>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return <View><Text style={styles.statValue}>{value ?? 0}</Text><Text style={typography.microLabel}>{label}</Text></View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: surface.base },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.stack },
  list: { padding: spacing.stack, gap: spacing.gutter },
  header: { gap: spacing.stack, paddingBottom: spacing.stack },
  avatarButton: { alignSelf: 'flex-start', gap: 6, minHeight: 48, justifyContent: 'center' },
  avatar: { width: 80, height: 80, borderRadius: 40 },
  avatarFallback: { width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center', backgroundColor: accent.base },
  avatarText: { ...typography.title, color: surface.base },
  avatarAction: { ...typography.microLabel, color: accent.base },
  username: { ...typography.page, color: content.primary },
  stats: { flexDirection: 'row', gap: spacing.stack },
  statValue: { ...typography.label, color: content.primary },
  section: { ...typography.label, color: content.primary },
  body: { ...typography.bodySecondary, color: content.tertiary, textAlign: 'center' },
  clip: { borderWidth: 1, borderColor: border.default, borderRadius: 12, padding: spacing.stack, gap: 4 },
  clipTitle: { ...typography.label, color: content.primary },
  retry: { marginTop: spacing.stack, borderWidth: 1, borderColor: accent.base, borderRadius: 999, paddingHorizontal: spacing.stack, paddingVertical: spacing.gutter },
  settings: { alignSelf: 'flex-start', minHeight: 48, justifyContent: 'center', borderWidth: 1, borderColor: accent.base, borderRadius: 999, paddingHorizontal: spacing.stack },
});
