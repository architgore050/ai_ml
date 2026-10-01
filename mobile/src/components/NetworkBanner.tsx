import React from 'react';
import { Text, View } from 'react-native';

import { content, surface, accent, status, spacing, zIndex, radius } from '../design/tokens';
import { typography } from '../design/typography';
import type { BackendStatus } from '../hooks/useBackendStatus';

/**
 * "Backend not reachable" banner. FRONTEND-REQUIREMENTS.md §4.9.
 *
 * Shown at `zIndex.networkBanner` (8000) — above the toast (5000) and
 * onboarding (7000), below nothing. It is a persistent structural fact about
 * the session, so it outranks transient messages; a toast that sits above it
 * would be hidden by a banner the user cannot dismiss.
 *
 * Distinguishes `offline` from `unknown` so a slow first check does not flash a
 * scary banner at a healthy user.
 */
export function NetworkBanner({ status }: { status: BackendStatus }) {
  if (status !== 'offline') return null;

  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID="network-banner"
      style={styles.banner}
    >
      <Text style={styles.title}>Backend not reachable</Text>
      <Text style={styles.body}>
        Check your connection. We will retry automatically.
      </Text>
    </View>
  );
}

/** Inline variant for forms, where a full-width banner would be noise. */
export function OfflineNotice({ status }: { status: BackendStatus }) {
  if (status !== 'offline') return null;
  return (
    <View style={styles.inline} testID="offline-notice">
      <Text style={styles.inlineText}>
        Cannot reach the server. Your change has not been saved.
      </Text>
    </View>
  );
}

const styles = {
  banner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: zIndex.networkBanner,
    backgroundColor: surface.containerHigh,
    borderBottomWidth: 1,
    borderBottomColor: status.danger,
    paddingHorizontal: spacing.gutter,
    paddingVertical: 10,
    gap: 2,
  },
  title: { ...typography.label, fontSize: 12, color: status.danger },
  body: { ...typography.body, fontSize: 11, color: content.secondary },
  inline: {
    padding: spacing.gutter,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: accent.base,
    backgroundColor: surface.container,
  },
  inlineText: { ...typography.body, fontSize: 12, color: content.secondary },
} as const;
