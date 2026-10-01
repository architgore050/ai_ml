import React from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Button } from '../src/components/ui/Button';
import { content, surface, spacing } from '../src/design/tokens';
import { typography } from '../src/design/typography';

/**
 * 404. The old app declared `scheme: "echoflow"` with zero deep-link handlers,
 * so a bad link crashed into a blank screen. D3's expo-router makes this route
 * the structural answer: an unknown path lands here instead of unmounting the
 * navigator.
 */
export default function NotFound() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <Text style={typography.microLabel}>404</Text>
      <Text style={styles.title}>Nothing here</Text>
      <Text style={styles.body}>
        That link does not match any screen in EchoFlow.
      </Text>
      <Button label="Go to feed" onPress={() => router.replace('/')} />
    </View>
  );
}

const styles = {
  container: {
    flex: 1,
    backgroundColor: surface.base,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    padding: spacing.stack,
    gap: spacing.gutter,
  },
  title: { ...typography.page, color: content.primary },
  body: { ...typography.bodySecondary, color: content.tertiary, textAlign: 'center' as const },
} as const;
