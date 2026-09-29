import React from 'react';
import { Text, View } from 'react-native';

import { Spinner } from '../../src/components/ui/Button';
import { content, surface, spacing, accent } from '../../src/design/tokens';
import { typography } from '../../src/design/typography';
import { NetworkBanner } from '../../src/components/NetworkBanner';
import { useBackendStatus } from '../../src/hooks/useBackendStatus';

/**
 * Placeholder for **Feed**. Arrives in Phase 2. Deliberately states
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
        <Text style={typography.microLabel}>Coming in Phase 2</Text>
        <Text style={styles.title}>Feed</Text>
        <Text style={styles.body}>
          Playback is Phase 2 and needs the token header transport. Nothing here plays audio yet.
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
