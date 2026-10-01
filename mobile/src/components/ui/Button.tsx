import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { content, type as typeScale, duration, accent } from '../../design/tokens';
import { typography } from '../../design/typography';
import {
  MIN_TOUCH_TARGET,
  onAccent,
  touchableStyle,
  uiStyles,
} from './primitives';

/**
 * Button. `accessibilityRole="button"` and a label are non-optional — plan §13
 * Accessibility requires both on every control, and the minHeight comes from
 * `uiStyles.button` (platform floor, not the 64px ideal).
 */

export type ButtonVariant = 'primary' | 'ghost';

export type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  accessibilityLabel,
  testID,
  style,
}: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        uiStyles.button,
        variant === 'primary' ? uiStyles.buttonPrimary : uiStyles.buttonGhost,
        pressed && variant === 'primary' && uiStyles.buttonPrimaryPressed,
        isDisabled && uiStyles.buttonDisabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? onAccent : accent.base} />
      ) : (
        <Text
          style={[
            typography.body,
            { color: variant === 'primary' ? onAccent : content.secondary },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * Icon button. Wraps a glyph in the platform touch minimum without inflating
 * the glyph, which is the fix for the design source's bare-`<X size={20}/>`-is-
 * a-20pt-target problem.
 */
export function IconButton({
  children,
  onPress,
  accessibilityLabel,
  disabled = false,
  testID,
  hitSlop,
  style,
}: {
  children: React.ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
  disabled?: boolean;
  testID?: string;
  hitSlop?: { top?: number; bottom?: number; left?: number; right?: number };
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      style={({ pressed }) => [
        touchableStyle(style),
        pressed && { opacity: 0.7, transform: [{ scale: 0.96 }] },
        disabled && { opacity: 0.4 },
      ]}
    >
      {children}
    </Pressable>
  );
}

/** Determinate bar. plan §13 EASE: progress fills are linear so the scrubber
 *  tracks audio rather than easing away from it. */
export function ProgressBar({
  progress,
  testID,
}: {
  /** 0..1 */
  progress: number;
  testID?: string;
}) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={styles.progressTrack}
    >
      <View
        style={[
          styles.progressFill,
          { width: `${clamped * 100}%` },
        ]}
      />
    </View>
  );
}

/** Centred spinner for loading states. */
export function Spinner({ label }: { label?: string }) {
  return (
    <View style={styles.spinner}>
      <ActivityIndicator size="large" color={content.tertiary} />
      {label ? <Text style={styles.spinnerLabel}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  progressTrack: {
    height: 4,
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: content.secondary,
  },
  spinner: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  spinnerLabel: {
    ...typography.label,
    fontSize: typeScale.label,
  },
});

export { MIN_TOUCH_TARGET, duration };
