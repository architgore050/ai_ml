import React from 'react';
import { ScrollView, Text, View } from 'react-native';

import { content, surface, border, accent, spacing } from '../design/tokens';
import { typography } from '../design/typography';
import { Button } from './ui/Button';

/**
 * Error boundary at the navigator root. The old `App.tsx` had none, so a render
 * throw in any screen produced a white screen with no way back.
 *
 * DEV only: `__DEV__` shows the stack inline. Production shows a message and a
 * retry that remounts the subtree — the right move for a transient render
 * error, and honest about not claiming to have fixed anything.
 */

type Props = {
  children: React.ReactNode;
};

type State = { error: Error | null; info: string | null; attempt: number };

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null, info: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // TODO: forward to Sentry in Phase 6. Not wired now — a crash reporter that
    // silently drops events is worse than none, and Phase 6 is where
    // `send_default_pii=False` behaviour gets decided.
    this.setState({ info: info.componentStack ?? null });
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.error('Unhandled error in navigator tree', error, info.componentStack);
    }
  }

  /**
   * Retry remounts the subtree by changing the `key`. Clearing the error alone
   * is not enough: React reuses the existing element instances, so a component
   * that threw during its own render throws again.
   */
  handleRetry = (): void => {
    this.setState((prev) => ({ error: null, info: null, attempt: prev.attempt + 1 }));
  };

  override render(): React.ReactNode {
    const { error, info, attempt } = this.state;
    if (!error) return <React.Fragment key={attempt}>{this.props.children}</React.Fragment>;

    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={typography.microLabel}>Something broke</Text>
          <Text style={[typography.page, styles.title]}>This screen hit an error</Text>
          <Text style={[typography.bodySecondary, styles.body]}>
            The app caught it instead of showing a blank screen. You can retry, or
            restart the app if it keeps happening.
          </Text>

          <Button label="Retry" onPress={this.handleRetry} testID="error-retry" />

          {__DEV__ ? (
            <View style={styles.debug}>
              <Text style={styles.debugText}>{error.message}</Text>
              {info ? <Text style={styles.debugText}>{info}</Text> : null}
            </View>
          ) : null}
        </ScrollView>
      </View>
    );
  }
}

const styles = {
  container: { flex: 1, backgroundColor: surface.base },
  content: { padding: spacing.stack, gap: spacing.gutter, flexGrow: 1 },
  title: { color: content.primary },
  body: { color: content.secondary },
  debug: {
    marginTop: spacing.stack,
    padding: spacing.gutter,
    backgroundColor: surface.container,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: border.default,
    gap: 8,
  },
  debugText: { ...typography.body, fontSize: 11, color: accent.base },
} as const;
