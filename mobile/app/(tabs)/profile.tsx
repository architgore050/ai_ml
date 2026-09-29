import React from 'react';
import { Text, View } from 'react-native';

import { Spinner } from '../../src/components/ui/Button';
import { content, surface, spacing, accent } from '../../src/design/tokens';
import { typography } from '../../src/design/typography';
import { NetworkBanner } from '../../src/components/NetworkBanner';
import { useBackendStatus } from '../../src/hooks/useBackendStatus';

/**
 * Placeholder for **Profile**. Arrives in Phase 4. Deliberately states
 * what is coming and what this screen is allowed to claim, rather than showing
 * a plausible-looking stub — a fake feed would be indistinguishable from a
 * broken one.
 */
export default function Screen() {
  const backend = useBackendStatus();

  return (
    <View style={{ flex: 1, backgroundColor: surface.base }}>
      <NetworkBanner status={backend} />
      <View style={styles.center}>
        <Text style={typography.microLabel}>Coming in Phase 4</Text>
        <Text style={styles.title}>Profile</Text>
        <Text style={styles.body}>
          Own profile uses /profile/me/ (which carries liked_clips). No follower/following drill-down exists server-side.
        </Text>
        {backend === 'unknown' ? <Spinner /> : null}
      </View>
    </View>
  );
}

const styles = {
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.stack,
    gap: 8,
  },
  title: { ...typography.page, color: content.primary },
  body: { ...typography.bodySecondary, color: content.tertiary, textAlign: 'center' as const },
} as const;
