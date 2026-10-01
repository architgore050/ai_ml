import { Platform, StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import {
  accessibility,
  accent,
  border,
  content,
  radius,
  spacing,
  status,
  surface,
  tint,
  m3,
} from '../../design/tokens';

/**
 * UI primitives. Tokens are the contract, not the rendered output — plan §16
 * explicitly excludes component snapshot tests, so these are thin wrappers over
 * tokens.ts rather than bespoke styled components.
 *
 * Every touchable goes through `touchableStyle`, which enforces the per-platform
 * minimums from tokens.accessibility. The design source declares
 * --tap-target: 64px and violates it everywhere (a bare 20px icon is ~20pt);
 * on mobile the *enforced* floor is 44pt iOS / 48dp Android.
 */

/** Enforced minimum touch target, per platform. */
export const MIN_TOUCH_TARGET = Platform.select({
  ios: accessibility.minTouchTargetIOS,
  android: accessibility.minTouchTargetAndroid,
  default: accessibility.minTouchTargetIOS,
});

/**
 * Expand a pressable's hit area to at least the platform minimum without
 * changing its visual size — the correct fix for icon buttons, which are often
 * just a 22px glyph. Use as the `style` of a `Pressable`.
 */
export function touchableStyle(base?: StyleProp<ViewStyle>): StyleProp<ViewStyle> {
  return [
    base,
    {
      minWidth: MIN_TOUCH_TARGET,
      minHeight: MIN_TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
    },
  ];
}

/** Hit-slop for icon buttons smaller than the enforced minimum. */
export const hitSlop = { top: 8, bottom: 8, left: 8, right: 8 };

/** Foreground that reads on the terracotta accent (globals.css:25 --on-primary). */
export const onAccent = m3.onPrimary;

export const uiTints = {
  accentSoft: tint(accent.base, '18'),
  accentGlow: accent.glow,
  likeGlow: tint('#ffb4ab', '18'),
  successSoft: status.successSoft,
  dangerSoft: tint(status.danger, '18'),
};

export const mutedText = content.tertiary;

export const uiStyles = StyleSheet.create({
  glass: {
    backgroundColor: surface.containerHigh,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: border.default,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  button: {
    minHeight: MIN_TOUCH_TARGET,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.stack,
  },
  buttonPrimary: {
    backgroundColor: accent.base,
  },
  buttonPrimaryPressed: {
    backgroundColor: accent.hover,
  },
  buttonGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: border.default,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  chip: {
    borderRadius: radius.full,
    paddingHorizontal: 12,
    paddingVertical: 6,
    justifyContent: 'center',
    borderWidth: 1,
  },
  input: {
    minHeight: MIN_TOUCH_TARGET,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: border.default,
    backgroundColor: surface.container,
    paddingHorizontal: spacing.gutter,
    paddingVertical: 12,
    color: content.primary,
    fontSize: 14,
  },
  inputFocused: {
    borderColor: accent.base,
  },
});
