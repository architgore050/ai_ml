import { StyleSheet } from 'react-native';
import type { TextStyle } from 'react-native';

import { content, font, tracking, type } from './tokens';

/**
 * Typography scale. Weights are 300-900 in Lexend (globals.css:1); the tracking
 * and size steps are plan §13 GLYPHS / TRACKING.
 *
 * The design intent (globals.css:77-78) is that "weight + tracking do the
 * work" — there is no separate display/body face, so the scale varies weight and
 * tracking across a single family rather than switching families.
 */

export const typography = StyleSheet.create({
  page: {
    fontFamily: font.display,
    fontSize: type.page,
    fontWeight: '800',
    color: content.primary,
    letterSpacing: tracking.title,
  },
  title: {
    fontFamily: font.display,
    fontSize: type.title,
    fontWeight: '700',
    color: content.primary,
    letterSpacing: tracking.title,
  },
  body: {
    fontFamily: font.body,
    fontSize: type.body,
    fontWeight: '400',
    color: content.primary,
  },
  bodySecondary: {
    fontFamily: font.body,
    fontSize: type.body,
    fontWeight: '400',
    color: content.secondary,
  },
  label: {
    fontFamily: font.body,
    fontSize: type.label,
    fontWeight: '600',
    color: content.secondary,
  },
  /** Uppercase micro-labels carry the widest tracking, plan §13. */
  microLabel: {
    fontFamily: font.body,
    fontSize: type.nav,
    fontWeight: '700',
    color: content.tertiary,
    letterSpacing: tracking.microLabel,
    textTransform: 'uppercase' as const,
  },
  count: {
    fontFamily: font.body,
    fontSize: type.count,
    fontWeight: '600',
    color: content.secondary,
  },
  nav: {
    fontFamily: font.body,
    fontSize: type.nav,
    fontWeight: '700',
    letterSpacing: tracking.microLabel,
    textTransform: 'uppercase' as const,
  },
});

export type TypographyVariant = keyof typeof typography;

/** Convenience for one-off styles that need a variant plus overrides. */
export function typeVariant(
  variant: TypographyVariant,
  overrides?: TextStyle,
): TextStyle {
  return { ...typography[variant], ...overrides };
}
