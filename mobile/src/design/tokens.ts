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
 * The gradient group is the one exception to "everything above is a CSS
 * variable line": no `linear-gradient()` in the design source lives in
 * globals.css — all four are inline `style` objects in the components, so they
 * are recorded by component file instead:
 *
 *   molecules.tsx:24    Btn `fill` — 135deg, --terracotta -> --accent-hover
 *   ReelCard.tsx:103    reel backdrop — 135deg, ${c}10 0% / ${c}22 50% / #121416
 *   ReelCard.tsx:180    waveform bars — `to top`, ${c} -> var(--sage)
 *   WaveformBar.tsx:36  progress fill — 90deg, ${c} -> var(--terracotta)
 *
 * where `${c}` is `getCatColor(clip.category)`, the same per-clip category
 * colour that `categories.ts::categoryColor` exposes here.
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

// Type-only, so it is erased at compile time and the token table stays a plain
// data module with no runtime dependency on the view layer. See
// LinearGradientSpec below for what the library actually accepts.
import type { LinearGradientProps } from 'expo-linear-gradient';

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
 *
 * THE KEY IS THE HEX SUFFIX, not a label. The web source writes the alpha as
 * the literal tail of an 8-digit hex — `${c}10`, `${c}22`, `${c}44` — and
 * `getCatColor` output is concatenated with it as a *string*
 * (ReelCard.tsx:103), so a step here has to match those suffixes exactly.
 * `'10'` is therefore not a spelling of `'0A'` and not a rounding of `'18'`:
 * `0x10` and `0x0A` are different bytes and the source asks for `0x10`.
 *
 * Inserted 2026-09-30 (Phase F) for the reel backdrop. Ordered by hex byte, so
 * `'10'` sits after `'0A'`, which is where the suffix scale puts it. NOTE the
 * value ordering disagrees — see the scale note below.
 *
 * KNOWN SCALE ANOMALY (found 2026-09-30, deliberately NOT fixed here): the seven
 * pre-existing steps transcribe the hex digits as a *decimal* fraction —
 * `0x18` is written `0.18`, `0x22` is `0.22` — whereas CSS resolves an alpha
 * byte as n/255, which would make those `0.094`, `0.133`, `0.200`, `0.267`,
 * `0.333`. So the legacy steps render 1.65x-2.55x MORE opaque than the web
 * source they came from, and `'10'` (0x10/256 = 0.0625) is the only step here
 * that matches its CSS value (exact parity would be 16/255 = 0.0627; the
 * 0.0002 difference is imperceptible). That is why `'10'` = 0.0625 sorts
 * *below* `'0A'` = 0.1 numerically while sitting above it by key.
 *
 * Do not "correct" the legacy values to n/255 in a drive-by edit: they have
 * live consumers (`components/ui/primitives.ts` renders `tint(accent.base,'18')`
 * on-screen today) and re-grading them is a visual redesign, not a token
 * rename. Tracked in docs/frontend_rebuild_plan.md.
 *
 * GOTCHA: `'10'` is an integer-like object key, so JS hoists it to the FRONT of
 * `Object.keys(tintSteps)` (`10 18 22 08 0A 33 44 55`) even though it is
 * written after `'0A'`. Anything iterating this table must `.sort()` it.
 */
export const tintSteps = {
  '08': 0.08,
  '0A': 0.1,
  '10': 0.0625,
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

/**
 * `tint()` for colours that arrive from outside this module — chiefly
 * `categoryColor()`, which returns a plain `string`. Reads the `tintSteps`
 * table above, so it is the SAME scale; the only difference is the input.
 *
 * WHY IT EXISTS — `tint()` cannot be handed a category colour, on either axis:
 *
 *  - **Compile-time.** `tint` takes `` `#${string}` `` but `categoryColor()`
 *    returns `string` (`categories.ts:75`). `tint(categoryColor(cat), '10')` is
 *    TS2345 "Argument of type 'string' is not assignable to parameter of type
 *    '`#${string}`'". Verified. The fix is a cast at every call site, which is
 *    exactly the kind of assertion that stops meaning anything after the first
 *    few.
 *  - **Runtime.** `tint` assumes a 6-digit `#`-prefixed hex and does not
 *    validate. It does not fail, it returns plausible garbage:
 *      tint('#fff', '10')     -> 'rgba(255, 15, NaN, 0.0625)'   (NaN blue)
 *      tint('#fff0', '10')    -> 'rgba(255, 240, NaN, 0.0625)'  (NaN blue)
 *      tint('9d8e84', '10')   -> 'rgba(216, 232, 4, 0.0625)'    (no NaN —
 *                               three real numbers, wrong colour; the worst
 *                               case, because nothing marks it as bad)
 *      tint('#e8a87cff','10') -> alpha silently dropped
 *      tint('rgb(1,2,3)','10')-> 'rgba(NaN, NaN, NaN, 0.0625)'
 *    All verified by execution. `tint()`'s signature is unchanged and its
 *    existing literal callers in `components/ui/primitives.ts` are unaffected;
 *    this is the entry point for runtime-sourced colours.
 *
 * Accepts 3-, 6- or 8-digit hex, with or without `#`. 8-digit input keeps its
 * own alpha rather than pretending it was opaque. Throws on anything that is
 * not hex at all, because the alternative — the silent `rgba(NaN,…)` above — is
 * an invisible wrong colour, and every value that reaches this in practice
 * comes from `categoryColor()`, which only ever returns one of six literals.
 */
export function tintColor(hex: string, step: TintStep): string {
  const alpha = tintSteps[step];
  // Expand 3/4-digit shorthand (#rgb, #rgba) so the byte pair below is real.
  const body = hex.startsWith('#') ? hex.slice(1) : hex;
  const full =
    body.length === 3 || body.length === 4
      ? [...body]
          .slice(0, 3)
          .map((ch) => ch + ch)
          .join('')
      : body;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) {
    throw new Error(
      `tintColor: expected a 3-, 6- or 8-digit hex, received ${JSON.stringify(hex)}`,
    );
  }
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const own = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : undefined;
  return `rgba(${r}, ${g}, ${b}, ${own === undefined ? alpha : own})`;
}

// ---------------------------------------------------------------------------
// Gradients
// ---------------------------------------------------------------------------

/** A point in `expo-linear-gradient`'s unit box: 0..1 of the element's w/h. */
type Point = { x: number; y: number };

/**
 * Props for one `<LinearGradient>`, narrowed to the four this file ever sets.
 *
 * `Pick` of the library's OWN type, not a hand-rolled lookalike, so a spec is
 * structurally guaranteed to be splattable into the component and a breaking
 * change upstream surfaces here instead of at the render site.
 *
 * Two corrections to the brief this was designed against, both verified in
 * node_modules/expo-linear-gradient/build/LinearGradient.d.ts — the public
 * props are NOT the native module's props:
 *
 *  - the point props are **`start` / `end`**, not `startPoint` / `endPoint`.
 *    `startPoint`/`endPoint` live on `NativeLinearGradientProps`
 *    (NativeLinearGradient.types.d.ts:6-7), the internal spec, and are not what
 *    a component receives.
 *  - `colors` is `readonly [ColorValue, ColorValue, ...ColorValue[]]` — a tuple
 *    of at least two, not `string[]` — and `locations` is the matching
 *    `readonly [number, number, ...number[]]`, which must be **ascending** and
 *    the same length as `colors`.
 *
 * `colors` and `locations` are kept as the library's own types so their arity
 * rules keep applying. `start`/`end` are narrowed to the `{ x, y }` object
 * form this file emits, because the library's `LinearGradientPoint` is a union
 * (`{ x, y }` | `[x, y]`) that is also nullable — which makes a bare `Pick`
 * splattable but unreadable, since `spec.start.x` would not compile. The
 * narrowed form is still assignable to the prop, so `<LinearGradient
 * {...gradients.brand} />` still typechecks.
 */
export type LinearGradientSpec = Pick<LinearGradientProps, 'colors' | 'locations'> & {
  start: Point;
  end: Point;
};

/**
 * CSS `linear-gradient(<deg>, …)` angle -> `expo-linear-gradient` start/end.
 *
 * THE TWO ARE NOT THE SAME PARAMETERISATION, and this is the whole reason the
 * helper exists. CSS measures an angle in degrees clockwise from "to top".
 * expo-linear-gradient takes a pair of POINTS in the unit box (0..1 of the
 * element's width and height), not an angle and not a direction vector. A 135deg
 * gradient therefore has no literal to copy.
 *
 * DERIVATION. Screen y grows DOWNWARD, in CSS and in RN alike, so the gradient
 * direction for angle t is
 *
 *     d = (sin t, -cos t)
 *
 *   t=0    -> (0, -1)  up        t=90   -> (1, 0)  right
 *   t=180  -> (0,  1)  down      t=270  -> (-1, 0) left
 *
 * t=135deg:  sin 135 = 2^0.5/2 = 0.7071,  cos 135 = -2^0.5/2, so
 *   d = (0.7071, -(-0.7071)) = (0.7071, 0.7071)  -> right and down, i.e.
 * top-left to bottom-right, which is what ReelCard.tsx:103 and
 * molecules.tsx:24 both draw.
 *
 * Only the DIRECTION of end - start is rendered; its length is irrelevant (the
 * stops are laid along the vector and the colour list spans it), so the vector
 * is anchored at the element centre, which keeps 135deg and its reverse
 * 315deg trivially comparable:
 *
 *     start = (0.5, 0.5) - d/2      end = (0.5, 0.5) + d/2
 *     d/2 = 0.7071 / 2 = 0.353553 = 2^0.5 / 4 = 1 / (2 * 2^0.5)
 *     start = (0.146447, 0.146447)   end = (0.853553, 0.853553)
 *
 * CHECKS, all verified by execution:
 *  - slope (end.y - start.y) / (end.x - start.x) = 1 exactly => a true 45deg
 *    line, and the pair is symmetric about 0.5 in both axes.
 *  - at 180deg the helper returns start (0.5, 0) and end (0.5, 1), which is
 *    EXACTLY this library's documented defaults. That is the sign-convention
 *    check: had y been taken as growing upward, the 0deg case would be right
 *    and this one inverted.
 *  - it therefore also says 0deg is `to top`, i.e. bottom to top, so the
 *    waveform's first colour lands at the BOTTOM. That is what the source means
 *    (ReelCard.tsx:180).
 *  - equivalently the 135deg line is the same line as start (0,0) -> end (1,1);
 *    the centre-anchored form is preferred only because it makes the angle
 *    legible and survives a future box that is not square.
 *
 * ROUNDING: results are rounded to 6 dp. That is not cosmetic — `Math.sin(PI)`
 * is 1.22e-16, not 0, so an unrounded 180deg returns x = 0.4999999999999999
 * rather than 0.5, while 90deg/270deg round back to exactly 0/0.5/1 on their
 * own. 6 dp is ~0.0004 px on a 400px card, i.e. far below anything observable,
 * and it keeps the four cardinal angles exact.
 */
export function linearGradientPoints(cssDegrees: number): { start: Point; end: Point } {
  const rad = (cssDegrees * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const q = (n: number): number => Math.round(n * 1e6) / 1e6;
  return {
    start: { x: q(0.5 - dx / 2), y: q(0.5 - dy / 2) },
    end: { x: q(0.5 + dx / 2), y: q(0.5 + dy / 2) },
  };
}

/**
 * The design source's four linear gradients. Take the per-clip category colour
 * from `categories.ts::categoryColor` and pass it in; nothing here is a baked
 * hex except the two brand stops, which are genuinely fixed.
 *
 * NOT in this file, on purpose: the ambient orbs. ReelCard.tsx:121-128 makes each
 * one a plain element with a flat fill plus a CSS `filter: blur(60px)` /
 * `blur(40px)`, which is a different mechanism on both platforms — on RN it is a
 * solid `backgroundColor` plus `filter: [{ blur: N }]`, not a gradient at all.
 * Encoding them as colours here would imply a gradient that does not exist.
 *
 * The radial dot-grid overlay (ReelCard.tsx:129-133) is likewise not a gradient
 * token; it is a repeated image.
 */
export const gradients: {
  /** Fixed: the source's stops are CSS variables, not category-derived. */
  readonly brand: LinearGradientSpec;
  readonly reelBackdrop: (categoryColor: string) => LinearGradientSpec;
  readonly progressFill: (categoryColor: string) => LinearGradientSpec;
  readonly waveformBar: (categoryColor: string) => LinearGradientSpec;
} = {
  /**
   * molecules.tsx:24 — `linear-gradient(135deg, var(--terracotta),
   * var(--accent-hover))` on `Btn`'s `fill` variant. Two stops and NO explicit
   * locations, so `locations` is omitted rather than pinned to [0, 1] — the
   * source expresses an even distribution by not expressing one, and the
   * library's own default is the even spread. Paired with `color: '#000'`, which
   * the source sets on the same element.
   */
  brand: {
    colors: [brand.terracotta, brand.terracottaHover],
    ...linearGradientPoints(135),
  },

  /**
   * ReelCard.tsx:103 — `linear-gradient(135deg, ${c}10 0%, ${c}22 50%,
   * #121416 100%)`, the reel's own background when `clip.cover_image` is
   * absent. The one gradient here with explicit stop positions, hence the
   * `locations`. `#121416` is `surface.base`/`surface.dim` verbatim.
   *
   * Both alpha stops go through `tintColor`, not `tint`: `${c}10`/`${c}22` are
   * string concatenations in the source, and the argument here is the plain
   * `string` that `categoryColor()` hands back.
   */
  reelBackdrop: (categoryColor: string) => ({
    colors: [tintColor(categoryColor, '10'), tintColor(categoryColor, '22'), surface.base],
    locations: [0, 0.5, 1],
    ...linearGradientPoints(135),
  }),

  /**
   * WaveformBar.tsx:36 — `linear-gradient(90deg, ${c}, var(--terracotta))` on
   * the played portion of the seek bar. 90deg is `to right`, so the category
   * colour leads on the left and the accent trails on the right; the reverse
   * would put the playhead colour on the wrong side of the wipe.
   */
  progressFill: (categoryColor: string) => ({
    colors: [categoryColor, brand.terracotta],
    ...linearGradientPoints(90),
  }),

  /**
   * ReelCard.tsx:180 — `linear-gradient(to top, ${c}, var(--sage))` on each of
   * the 40 decorative background bars. `to top` IS `0deg`, so the first colour
   * is at the BOTTOM of each bar and sage sits at the top. The trap here is not
   * the 135deg diagonal one — it is 0 against 180: swapping them puts sage at
   * the bottom of every bar, and that still renders as a plausible gradient, so
   * nothing but the numbers catches it.
   */
  waveformBar: (categoryColor: string) => ({
    colors: [categoryColor, brand.sage],
    ...linearGradientPoints(0),
  }),
};

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
