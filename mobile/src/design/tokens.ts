/**
 * Design tokens — the single source of truth for the visual system.
 *
 * D6: tokens in TypeScript + StyleSheet.create, not NativeWind. The product's
 * identity is backdrop-blur glass, coloured outer glows with no elevation
 * scale, radial orbs and 8-digit-hex alpha tinting. NativeWind handles none of
 * those cleanly, and the glow story is a Platform.select problem regardless.
 *
 * PROVENANCE (D7): values transcribed from
 * `frontend/sample_frontend2/src/styles/globals.css` + `tailwind.config.js`.
 * That directory is **gitignored** (.gitignore:26) and is a local scratch copy
 * of a design-tool export, not a maintained source — which is precisely why the
 * values had to be transcribed here. Every group below records the line it came
 * from so a future re-extraction can be diffed rather than guessed.
 *
 *   globals.css:9-60    palette
 *   globals.css:81-85   radii
 *   globals.css:88-91   spacing
 *   globals.css:65-68   derived / accent
 *   globals.css:60      glass
 *   globals.css:203-223 component layer (glass, blur, easing)
 *   tailwind.config.js:31-44  radii + spacing
 *   tailwind.config.js:45-49  glow box-shadows
 *
 * TWO RESOLVED CONFLICTS — do not "fix" either of these back:
 *
 *  1. `surface.bright` is #38393c, from globals.css:11. tailwind.config.js:15
 *     says #282a2c, which is the value of globals.css:15's
 *     `--surface-container-high` — the Tailwind config collapsed two distinct
 *     steps into one label. globals.css is right: it keeps `surface-bright` a
 *     step ABOVE `--surface-container-highest` (#333537, globals.css:16),
 *     giving the 6-step ascending brightness ramp below, and it does the same in
 *     the light theme (#ffffff over #e2dcd4). Decision O3, 2026-09-29.
 *
 *  2. The plan's §13 LAYOUT line says "14px gutter". globals.css:89 says
 *     `16px`. globals.css is authoritative per D7, so this file uses 16. The
 *     plan line is stale; corrected in mobile-rebuild-plan.md.
 */

/* eslint-disable no-restricted-syntax */

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * 6-step ascending brightness ramp, darkest to lightest. `bright` sits above
 * `container.highest` — that ordering is the whole point of conflict (1) above.
 */
export const surface = {
  /** globals.css:53 --background */
  base: '#121416',
  /** globals.css:10 --surface-dim */
  dim: '#121416',
  /** globals.css:11 --surface-bright — see conflict (1) */
  bright: '#38393c',
  /** globals.css:12 --surface-container-lowest */
  containerLowest: '#0c0e10',
  /** globals.css:13 --surface-container-low */
  containerLow: '#1a1c1e',
  /** globals.css:14 --surface-container */
  container: '#1e2022',
  /** globals.css:15 --surface-container-high */
  containerHigh: '#282a2c',
  /** globals.css:16 --surface-container-highest */
  containerHighest: '#333537',
  /** globals.css:55 --surface-variant */
  variant: '#333537',
} as const;

/** globals.css:17-18, 21-22, 70-74 */
export const content = {
  /** globals.css:17 --on-surface */
  primary: '#e2e2e5',
  /** globals.css:18 --on-surface-variant */
  secondary: '#d5c3b9',
  /** globals.css:21 --outline */
  tertiary: '#9d8e84',
  /** globals.css:22 --outline-variant */
  disabled: '#51443d',
  /** globals.css:18 --inverse-surface */
  inverseSurface: '#e2e2e5',
  /** globals.css:19 --inverse-on-surface */
  inverseOnSurface: '#2f3133',
} as const;

export const border = {
  /** globals.css:73 --border -> --outline-variant */
  default: '#51443d',
  /** globals.css:74 --border-strong -> --outline */
  strong: '#9d8e84',
} as const;

/**
 * Brand. The accent is terracotta; the old app used frontend/src's orange
 * #FF6321, which is not this design system (D7) — see SALVAGE.ts.
 */
export const brand = {
  /** globals.css:56 --terracotta */
  terracotta: '#e8a87c',
  /** globals.css:64 --accent-hover */
  terracottaHover: '#d4956a',
  /** globals.css:57 --midnight */
  midnight: '#121416',
  /** globals.css:29,58 --secondary, --sage */
  sage: '#aad0b1',
  /** globals.css:35,59 --tertiary-container, --honey-gold */
  honeyGold: '#f1ce6d',
  /** globals.css:37 --error */
  like: '#ffb4ab',
} as const;

export const accent = {
  /** globals.css:63 --accent -> --terracotta */
  base: brand.terracotta,
  /** globals.css:64 --accent-hover */
  hover: brand.terracottaHover,
  /** globals.css:65 --accent-soft */
  soft: 'rgba(232, 168, 124, 0.12)',
  /** globals.css:66 --accent-glow */
  glow: 'rgba(232, 168, 124, 0.25)',
} as const;

export const status = {
  /** globals.css:67 --success -> --sage */
  success: brand.sage,
  /** globals.css:68 --success-soft */
  successSoft: 'rgba(170, 208, 177, 0.12)',
  /** globals.css:69 --danger -> --error */
  danger: brand.like,
  /** globals.css:38 --on-error */
  dangerOn: '#690005',
  /** globals.css:39 --error-container */
  dangerContainer: '#93000a',
  /** globals.css:40 --on-error-container */
  dangerContainerOn: '#ffdad6',
} as const;

/** globals.css:24-36, 41-52 — Material 3 role pairs not used by the MVP yet. */
export const m3 = {
  primary: '#ffeade',
  onPrimary: '#4a280c',
  primaryContainer: '#ffc69f',
  onPrimaryContainer: '#7a5031',
  inversePrimary: '#7f5536',
  surfaceTint: '#f3bb95',
  secondary: brand.sage,
  onSecondary: '#153721',
  secondaryContainer: '#2c4e36',
  onSecondaryContainer: '#99bea0',
  tertiary: '#ffecc1',
  onTertiary: '#3d2f00',
  tertiaryContainer: brand.honeyGold,
  onTertiaryContainer: '#6f5700',
  primaryFixed: '#ffdcc5',
  primaryFixedDim: '#f3bb95',
  onPrimaryFixed: '#301400',
  onPrimaryFixedVariant: '#643e20',
  secondaryFixed: '#c5eccc',
  secondaryFixedDim: brand.sage,
  onSecondaryFixed: '#00210e',
  onSecondaryFixedVariant: '#2c4e36',
  tertiaryFixed: '#ffe08d',
  tertiaryFixedDim: '#e5c363',
  onTertiaryFixed: '#241a00',
  onTertiaryFixedVariant: '#584400',
} as const;

/** globals.css:60 --surface-overlay; :221 the matching backdrop-filter blur */
export const glass = {
  background: 'rgba(18, 20, 22, 0.6)',
  /** px — globals.css:221 */
  blur: 20,
  /** globals.css:225 .glass-light, for light-surface scrims */
  light: 'rgba(255, 255, 255, 0.08)',
} as const;

/**
 * 8-digit-hex alpha tints, plan §13. The web source composes
 * `${color}${alpha}`; React Native has no hex-alpha shorthand on all versions,
 * so this exposes the alpha steps as data and `tint()` in tokens below does the
 * composition. Keeping the steps named is the point — the old app had 16
 * hardcoded alpha values with no scale behind them.
 */
export const tintSteps = {
  '08': 0.08,
  '0A': 0.1,
  '18': 0.18,
  '22': 0.22,
  '33': 0.33,
  '44': 0.44,
  '55': 0.55,
} as const;

export type TintStep = keyof typeof tintSteps;

/** Compose a colour with a named tint step, e.g. tint(brand.terracotta, '18'). */
export function tint(hex: `#${string}`, step: TintStep): string {
  const alpha = tintSteps[step];
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ---------------------------------------------------------------------------
// Radius — globals.css:81-85, tailwind.config.js:31-37
// ---------------------------------------------------------------------------

export const radius = {
  sm: 8, // 0.5rem
  DEFAULT: 16, // 1rem — tailwind.config.js:34 only
  md: 24, // 1.5rem
  lg: 32, // 2rem
  xl: 48, // 3rem
  full: 9999, // 9999px
} as const;

// ---------------------------------------------------------------------------
// Spacing — globals.css:88-91, tailwind.config.js:39-44
// ---------------------------------------------------------------------------

export const spacing = {
  /** globals.css:88 --margin-mobile */
  marginMobile: 20,
  /** globals.css:89 --gutter-md. Plan §13's "14px gutter" is stale — see (2). */
  gutter: 16,
  /** globals.css:90 --interaction-stack */
  stack: 24,
  /** globals.css:91 --tap-target. This is the *ideal*, not the floor — see
   *  accessibility.ts for the enforced per-platform minimums. */
  tapTarget: 64,
} as const;

/**
 * Blur scale, plan §13. RN has no backdrop-filter, so these drive
 * `expo-blur` intensity and the `BlurView` radius, not a CSS filter.
 */
export const blur = {
  scrimSmall: 6,
  scrim: 8,
  button: 10,
  modal: 16,
  chrome: 20, // = glass.blur
} as const;

// ---------------------------------------------------------------------------
// Typography — globals.css:1, 77-78
// ---------------------------------------------------------------------------

export const font = {
  display: 'Lexend_600SemiBold',
  body: 'Lexend_400Regular',
  weights: {
    light: '300' as const,
    regular: '400' as const,
    medium: '500' as const,
    semiBold: '600' as const,
    bold: '700' as const,
    extraBold: '800' as const,
    black: '900' as const,
  },
} as const;

/** plan §13 GLYPHS */
export const type = {
  icon: 22,
  nav: 9,
  count: 10,
  label: 11,
  body: 13,
  title: 20,
  page: 28,
} as const;

/** plan §13 TRACKING */
export const tracking = {
  title: 0.02,
  microLabel: 0.08,
} as const;

// ---------------------------------------------------------------------------
// Motion — globals.css:216-218, 205, 208
// ---------------------------------------------------------------------------

export const easing = {
  /** globals.css:216 .pop-in — overshoots past 1 then settles */
  pop: '0.35s cubic-bezier(0.34, 1.56, 0.64, 1)',
  /** globals.css:218 .slide-up */
  slide: '0.32s cubic-bezier(0.22, 0.61, 0.36, 1)',
  /** globals.css:217 .fade-up */
  fade: '0.3s ease',
  /** globals.css:92 --transition */
  base: '0.2s ease',
} as const;

export const duration = {
  /** plan §13 EASE — progress fills are linear so the scrubber tracks audio */
  progressFill: 100,
  shimmer: 1400,
  waveBar: 1000,
  fadeUp: 300,
  popIn: 350,
  slideUp: 320,
  press: 96, // plan §13 "active:scale-0.96 press states"
} as const;

/** plan §13 PACING — inter-reel pause, ms */
export const pacing = {
  interReelPause: 1000,
  /** plan §13: autoplay at 70% viewability */
  autoplayViewability: 0.7,
  /** plan §13 / 4.1: the completion guard boundary. position < duration * this
   *  counts as a skip. Above it, the clip was heard to the end. */
  completionThreshold: 0.9,
} as const;

// ---------------------------------------------------------------------------
// Layering — plan §13 Z
// ---------------------------------------------------------------------------

export const zIndex = {
  nav: 200,
  sheet: 800,
  toast: 5000,
  onboarding: 7000,
  networkBanner: 8000,
} as const;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export const layout = {
  headerHeight: 56,
  navClearance: 100,
  /** plan §13 — max content column so a large phone doesn't stretch cards */
  contentMax: 470,
} as const;

/**
 * Accessibility floors. The web source declares --tap-target: 64px and violates
 * it everywhere (a bare `<X size={20}/>` is ~20pt). On mobile the platform
 * minimums are the enforced floor and 64 is the ideal, not the requirement.
 */
export const accessibility = {
  minTouchTargetIOS: 44, // pt
  minTouchTargetAndroid: 48, // dp
} as const;
