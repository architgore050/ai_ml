import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { FilterFunction, ViewStyle } from 'react-native';

import { categoryColor } from '../../design/categories';
import { radius, tintColor, type TintStep } from '../../design/tokens';

/**
 * The ambient orb backdrop behind a reel's content.
 *
 * DESIGN SOURCE — `frontend/sample_frontend2/src/components/audio/ReelCard.tsx`
 * lines 121-128 (read via `git show 20451d3:…`, the only surviving copy of
 * that gitignored directory). Two flat-filled circles, absolutely positioned
 * inside the card, blurred:
 *
 *   div { position:'absolute', width:280, height:280, borderRadius:'var(--radius-full)',
 *         background: c+'08', top:'10%', right:'-10%', filter:'blur(60px)' }
 *   div { position:'absolute', width:200, height:200, borderRadius:'var(--radius-full)',
 *         background: c+'0A', bottom:'20%', left:'-5%', filter:'blur(40px)' }
 *
 * They render only in the `else` branch of the source's `cover_image` ternary,
 * i.e. they are the backdrop for a clip with NO cover art. This component does
 * not draw the cover image and does not decide whether one exists; the caller
 * places it in the no-cover slot. That decision is the caller's because it also
 * decides whether the gradient underneath (`gradients.reelBackdrop`) is drawn.
 *
 * ---------------------------------------------------------------------------
 * WHY A NATIVE `filter` AND NOT `expo-blur` / A PRE-BLURRED ASSET
 * ---------------------------------------------------------------------------
 * RN 0.86 supports CSS-style filters natively. Confirmed in the installed tree,
 * not from memory:
 *
 *   StyleSheetTypes.d.ts:517   `filter?: ReadonlyArray<FilterFunction> | string`
 *                              — inside `interface ViewStyle` (opens at :464),
 *                                so it is a plain View style prop.
 *   StyleSheetTypes.d.ts:324   `export type FilterFunction` — a union of
 *                              single-key objects including `{blur}`.
 *   BaseViewConfig.android.js:207 / .ios.js:250  `filter: filterAttribute`.
 *   BaseViewManager.java:234   `@ReactProp(name = ViewProps.FILTER, customType = "Filter")`
 *                              `setFilter(view, filter)`.
 *
 * `blur` here is a FOREGROUND filter on the orb itself (CSS `filter`, not
 * `backdrop-filter`), which is a different mechanism from the `blur.*` token
 * group in tokens.ts, which drives `expo-blur` intensity for the glass chrome.
 * The orbs blur themselves, so they need none of it.
 *
 * ANDROID FLOOR — verified, and it is silent, so it is worth stating plainly:
 * `BaseViewManager.java:556-558` only reaches `view.setRenderEffect(...)` inside
 * `else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)`. Below API 31
 * (Android 12) there is no `else`, no log and no throw — a VALID filter array
 * renders as a hard-edged, unblurred circle. That is a platform capability gap,
 * not a defect in this file, and no amount of correct JS changes it. The
 * pre-12 fallback would be an `expo-blur` or pre-blurred-asset layer, which is
 * explicitly out of scope here; raise it as its own decision rather than
 * smuggling a second rendering path in.
 */

/**
 * Build a `blur` filter that `processFilter` cannot reject.
 *
 * THE TRAP THIS EXISTS TO DEFEND AGAINST — `processFilter` is all-or-nothing.
 * Both the string branch (`Libraries/StyleSheet/processFilter.js:85-88`) and the
 * array branch (`:112-115`) carry the same comment and the same behaviour:
 *
 *     // If any primitive is invalid then apply none of the filters. [...]
 *     return [];
 *
 * ONE bad value silently discards the WHOLE chain. The orb then renders as a
 * hard-edged circle with no blur, and nothing anywhere logs — including in dev.
 * The same shape of failure would come from a single `undefined` leaking in
 * from a conditional style.
 *
 * THE UNIT RESTRICTION — `processFilter.js:161-162`:
 *
 *     case 'blur':
 *       if ((unit && unit !== 'px') || filterArgAsNumber < 0) return undefined;
 *
 * so a non-`px` unit or a negative number poisons the whole filter. The ARRAY
 * form is used exclusively, and consistently. In the array branch `filterValue`
 * arrives as a number, `unit` is never assigned, and the `(unit && ...)` guard
 * short-circuits on `undefined` — which is precisely what makes a bare
 * `{blur: 60}` legal where the string form would demand `'blur(60px)'`. (The
 * source comment at :157-160 says as much: "In RN we currently only have DIPs,
 * so we are not parsing units here.") One form, everywhere: mixing a string
 * filter into this file later is how a future edit ends up with a unit that
 * `processFilter` silently refuses.
 *
 * WHY IT THROWS rather than degrading — a guard that falls back to "no filter"
 * reproduces the exact failure it was written to prevent, with none of the
 * signal. Every argument is a module-level literal from `ORBS` below, so this
 * runs once at import; a future edit that breaks a radius fails immediately and
 * audibly instead of shipping a hard-edged circle to every user.
 */
function blurFilter(blurRadiusPx: number): ReadonlyArray<FilterFunction> {
  if (!Number.isFinite(blurRadiusPx) || blurRadiusPx < 0) {
    throw new RangeError(
      `AmbientOrbs: blur radius must be a finite, non-negative number of DIPs, got ` +
        `${String(blurRadiusPx)}. processFilter discards the ENTIRE filter array for one ` +
        `invalid primitive, so this would render as an unblurred hard-edged circle with ` +
        `no warning. Pass a bare non-negative number and let the array form carry it.`,
    );
  }
  return [{ blur: blurRadiusPx }];
}

/**
 * Only the four edges an orb is offset by, narrowed to `ViewStyle` so the
 * percentage strings typecheck as a style rather than as an opaque
 * `Record<string, string>` — an untyped record is not assignable to
 * `StyleProp<ViewStyle>` and would need a cast at the render site.
 */
type OrbOffset = Pick<ViewStyle, 'top' | 'right' | 'bottom' | 'left'>;

/**
 * The two orbs, transcribed. `size`, `step` (the hex alpha byte the source
 * concatenates), `blur` and `offset` are each read off the two `<div>`s in the
 * design source quoted above.
 *
 * `step` is the KEY in `tintSteps`, not a number: the source writes the alpha as
 * the literal tail of an 8-digit hex (`c+'08'`, `c+'0A'`), and tokens.ts spells
 * that constraint out — `'08'` is not a spelling of `'0A'`.
 */
const ORBS: ReadonlyArray<{
  id: string;
  size: number;
  step: TintStep;
  blur: number;
  offset: OrbOffset;
}> = [
  { id: 'A', size: 280, step: '08', blur: 60, offset: { top: '10%', right: '-10%' } },
  { id: 'B', size: 200, step: '0A', blur: 40, offset: { bottom: '20%', left: '-5%' } },
];

/**
 * Resolved once, at module load, so `blurFilter` is a one-time import-time check
 * rather than a per-render cost, and so a bad literal can never reach a render
 * where it might depend on a branch.
 */
const ORB_FILTERS: Readonly<Record<string, ReadonlyArray<FilterFunction>>> = Object.fromEntries(
  ORBS.map((orb) => [orb.id, blurFilter(orb.blur)]),
);

/**
 * Rendered as a single `absoluteFill` layer so it takes no space in the card's
 * layout and can never be what the card measures. It must be rendered BEFORE the
 * content it sits behind; painting follows sibling order, so it draws underneath
 * and needs no z-index.
 *
 * `overflow: 'hidden'` is here, not assumed of the card. Both orbs are positioned
 * partly OUTSIDE the box — `right: '-10%'` and `left: '-5%'` — and the source
 * clips them at the card edge (`overflow: 'hidden'` on both of its divs). Clipping
 * the orbs at this layer's bounds reproduces that without making the component
 * depend on a `ReelCard` that is a different file and may be edited independently.
 * A filter's output is clipped by its ancestor's overflow, exactly as in CSS, so
 * the blur still bleeds inward from the card edge and is cut at it.
 *
 * `category` is resolved through `categoryColor`, which falls back to the neutral
 * colour for the legacy six and for any unknown value — `AudioClip.category` is
 * free text (`models.py:112`, `CharField` with no `choices`), so an
 * unrecognised string is a normal input, not an error.
 *
 * The colour itself goes through `tintColor` and NOT `tint`. `tint` is typed
 * `` `#${string}` `` and `categoryColor` returns a plain `string`, so `tint` is a
 * compile error here before it is a runtime one; and it does not validate, so it
 * would fail silently if the cast were added — `'#fff'` yields
 * `rgba(255, 15, NaN, …)` and a `#`-less `'9d8e84'` yields three real numbers
 * that are simply the wrong colour. `tintColor` takes the same runtime `string`,
 * reads the same `tintSteps` scale, and throws on anything that is not hex.
 */
export function AmbientOrbs({ category }: { category: string }) {
  const base = categoryColor(category);
  return (
    <View
      testID="ambient-orbs"
      style={styles.backdrop}
      // Decorative: it must not be reachable by a screen reader, and it must
      // not intercept a tap aimed at the card underneath.
      //
      // `aria-hidden` rather than `accessibilityElementsHidden`: the latter is
      // declared `@platform ios` (ViewAccessibility.d.ts:285-291), and its
      // Android counterpart `importantForAccessibility` is declared
      // `@platform android` (:270-275). `aria-hidden` is the cross-platform
      // primitive — View.js:71-76 expands it to BOTH
      // (`accessibilityElementsHidden` for iOS, `importantForAccessibility:
      // 'no-hide-descendants'` for Android) when the legacy prop transform runs,
      // and the native view configs take it directly when it does not. Setting
      // the iOS-only prop alone would have left Android announcing the orbs.
      aria-hidden={true}
      pointerEvents="none"
    >
      {ORBS.map((orb) => (
        <View
          key={orb.id}
          testID={`ambient-orb-${orb.id}`}
          style={[
            styles.orb,
            {
              width: orb.size,
              height: orb.size,
              backgroundColor: tintColor(base, orb.step),
            },
            // Percentage offsets resolve against THIS parent's box, exactly as
            // in CSS: `top`/`bottom` against its height, `left`/`right` against
            // its width. The parent is the reel cell, whose height is the MEASURED
            // viewport (see lib/feedViewport.ts) and not `window.height`. Nothing
            // here reads the window or assumes a parent size: the orbs are
            // absolutely positioned so they contribute nothing to layout, and
            // their own `size` is the fixed px the source specifies.
            orb.offset,
            { filter: ORB_FILTERS[orb.id] },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, overflow: 'hidden' },
  orb: { position: 'absolute', borderRadius: radius.full },
});
