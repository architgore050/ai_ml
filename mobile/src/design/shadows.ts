import { Platform } from 'react-native';
import type { ViewStyle } from 'react-native';

import { accent, brand } from './tokens';

/**
 * Cross-platform glow. See plan §13 "Known porting problem".
 *
 * The web glow is `box-shadow: 0 0 20px rgba(...)` (tailwind.config.js:45-49).
 * On iOS that is reproducible with `shadowColor` / `shadowOpacity` /
 * `shadowRadius` at `shadowOffset: {0, 0}`. **On Android it is not** — RN
 * Android ignores `shadowColor` for `elevation`-based shadows and renders a
 * generic grey blur, so a coloured glow is simply not expressible.
 *
 * Rather than hide that, the Android branch is a deliberate, documented visual
 * degradation: hero elements get an `expo-linear-gradient` ring, everything else
 * drops the glow. See `glowRing()` for the gradient form.
 *
 * Values: 0 0 {6,8,12,16,20,24,32}px var(--accent-glow), plan §13 GLOW.
 */

type GlowRadius = 6 | 8 | 12 | 16 | 20 | 24 | 32;

function iosGlow(radius: GlowRadius, color: string): ViewStyle {
  // shadowOpacity has to be a plain alpha because Android's elevation shadow
  // tints with `shadowColor`; on iOS it is simply the alpha multiplier. Using
  // the colour's own alpha keeps the two branches visually comparable.
  const alpha = Number(color.match(/[\d.]+\)$/)?.[0].replace(')', '') ?? 0.25);
  return {
    shadowColor: color.startsWith('#') ? color : accent.base,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: alpha,
    shadowRadius: radius,
  };
}

function androidGlow(radius: GlowRadius): ViewStyle {
  // Documented degradation: no coloured glow on Android. A grey elevation blur
  // would be worse than nothing — it reads as a rendering bug rather than a
  // design choice — so hero elements use glowRing() instead and the rest get
  // no shadow at all.
  void radius;
  return {};
}

/** The accent glow at a given radius, per platform. */
export function glow(radius: GlowRadius = 20, color: string = accent.glow): ViewStyle {
  return Platform.select({
    ios: iosGlow(radius, color),
    android: androidGlow(radius),
    default: iosGlow(radius, color),
  }) as ViewStyle;
}

/** Named glows, matching tailwind.config.js:45-49. */
export const shadows = {
  glow: glow(20, accent.glow),
  glowSage: glow(20, 'rgba(170, 208, 177, 0.25)'),
  glowGold: glow(20, 'rgba(241, 206, 109, 0.25)'),
} as const;

/**
 * Android glow-ring gradient stops for `expo-linear-gradient`. Used on the few
 * hero elements the plan allows: the create FAB and the liked heart. The web
 * `glow` shadow is `0 0 20px <colour at 0.25>`, so the ring runs
 * 0.25 -> 0 across the gradient with the 20px spread expressed as the outer
 * stop's extent.
 */
export function glowRingStops(color: string, alpha = 0.25) {
  return [
    { color: color.replace(/^#(\w{2})(\w{2})(\w{2})$/, (_, r, g, b) => `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${alpha})`), position: 0 },
    { color: 'transparent', position: 1 },
  ] as const;
}

/** Hex form of the brand accent, for `glowRingStops` callers. */
export const glowRingColor = brand.terracotta;
