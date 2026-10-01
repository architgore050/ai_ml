import React from 'react';
import { StyleSheet } from 'react-native';
import { isHiddenFromAccessibility, render } from '@testing-library/react-native';
import type { TestInstance } from 'test-renderer';

import { AmbientOrbs } from '../AmbientOrbs';
import {
  BRANDED_CATEGORIES,
  categoryColor,
  LEGACY_CATEGORIES,
  NEUTRAL_CATEGORY_COLOR,
} from '../../../design/categories';
import { radius, tintColor } from '../../../design/tokens';

/**
 * ---------------------------------------------------------------------------
 * WHAT THESE TESTS CANNOT PROVE — read before trusting a green run
 * ---------------------------------------------------------------------------
 *
 * **Blur RENDERING is unverifiable under jest, and the trap was reproduced
 * directly while writing this file.** `processFilter` is native-side. The jest
 * environment renders React elements and hands the `filter` value to the view
 * verbatim: a probe rendering `<View style={{filter:[{blur:60}]}}/>` produced
 * `toJSON().props.style` containing `filter: [{blur: 60}]` — byte-identical,
 * unvalidated, unparsed. Nothing in the JS test path ever runs
 * `Libraries/StyleSheet/processFilter.js`.
 *
 * So an INVALID filter value — a negative radius, a `%` unit, a stray
 * `undefined` — passes through into the rendered style and passes every
 * assertion in this file. It fails only on device, and per
 * `processFilter.js:85-88` / `:112-115` it fails SILENTLY: one bad primitive
 * discards the whole array and returns `[]`, so the orb renders as a hard-edged
 * circle and nothing logs.
 *
 * These tests therefore assert the VALUE AND SHAPE OF WHAT IS EMITTED — a
 * single-element array, holding a single-key object, whose blur is a finite
 * non-negative NUMBER. That is everything checkable from JS, and it is what
 * makes the array form legal in the first place: in the array branch the value
 * arrives as a number, `unit` is never assigned, and the
 * `(unit && unit !== 'px')` guard short-circuits on `undefined`
 * (`processFilter.js:157-162`).
 *
 * There is deliberately NO test named after or asserting blur rendering. A test
 * that appeared to verify it would be measuring `StyleSheet.flatten` and calling
 * it a rendering check — worse than no test, because it would read as coverage of
 * the one property that actually breaks silently.
 *
 * A second, independent limit no jest assertion could reach: on Android below
 * API 31 a perfectly VALID filter still does not render, because
 * `BaseViewManager.java:556-558` only reaches `setRenderEffect` inside
 * `else if (SDK_INT >= VERSION_CODES.S)` — no `else`, no log.
 */

/**
 * The component's constants, restated here so drift surfaces as a FAILURE
 * rather than as a test that quietly agrees with whatever the component does.
 */
const ORB_A = { size: 280, step: '08', blur: 60 } as const;
const ORB_B = { size: 200, step: '0A', blur: 40 } as const;

type RenderResult = Awaited<ReturnType<typeof render>>;

/**
 * Flatten the emitted style to a plain object.
 *
 * The orb's style is an ARRAY (`[styles.orb, {…}, offset, {filter}]`), so the
 * assertions read the resolved product rather than one element of it — the
 * offsets and the filter exist only as later entries, and asserting the raw
 * array would pin an implementation detail that does not matter.
 */
function styleOf(node: TestInstance): Record<string, unknown> {
  return (StyleSheet.flatten(node.props.style) ?? {}) as Record<string, unknown>;
}

/**
 * Query with `includeHiddenElements`, which this component REQUIRES.
 *
 * RNTL 14 excludes accessibility-hidden subtrees from queries by default
 * (`config.js:16`, `defaultIncludeHiddenElements: false`), and it is a
 * PER-QUERY option, not a render option. This component is `aria-hidden` by
 * design, so a plain `getByTestId` throws "Unable to find an element with
 * testID" — which is the library confirming the orbs really are invisible to
 * assistive technology.
 *
 * It is passed per query rather than flipped globally in `jest.setup.js` on
 * purpose: a global `defaultIncludeHiddenElements: true` would stop other
 * suites from noticing when something that SHOULD be announced is not.
 */
function node(r: RenderResult, testID: string): TestInstance {
  return r.getByTestId(testID, { includeHiddenElements: true });
}

/** Both orbs' flattened styles, in the source's A/B order. */
function orbStyles(r: RenderResult): { a: Record<string, unknown>; b: Record<string, unknown> } {
  return { a: styleOf(node(r, 'ambient-orb-A')), b: styleOf(node(r, 'ambient-orb-B')) };
}

describe('AmbientOrbs', () => {
  describe('rendering', () => {
    it('renders both orbs', async () => {
      const r = await render(<AmbientOrbs category="instrumental" />);
      expect(node(r, 'ambient-orb-A')).toBeTruthy();
      expect(node(r, 'ambient-orb-B')).toBeTruthy();
    });

    it('takes no space in the card layout', async () => {
      // absoluteFill: the orbs are a backdrop layer, so they must not be what the
      // reel cell measures. The card's height is the MEASURED viewport, not the
      // window (lib/feedViewport.ts) — a backdrop that participated in layout
      // would feed straight back into that measurement.
      const r = await render(<AmbientOrbs category="instrumental" />);
      expect(styleOf(node(r, 'ambient-orbs'))).toMatchObject({ position: 'absolute' });
    });

    it('clips at its own bounds, so it does not depend on the card clipping', async () => {
      // Both orbs sit partly OUTSIDE the box (`right: '-10%'`, `left: '-5%'`) and
      // the source cuts them at the card edge via `overflow: hidden`. The card is
      // a different file that other work is editing concurrently, so the guarantee
      // is held here rather than assumed of it.
      const r = await render(<AmbientOrbs category="instrumental" />);
      expect(styleOf(node(r, 'ambient-orbs'))).toMatchObject({ overflow: 'hidden' });
    });
  });

  describe('geometry', () => {
    it('sizes each orb to the design source and makes it a circle', async () => {
      const { a, b } = orbStyles(await render(<AmbientOrbs category="instrumental" />));
      expect(a).toMatchObject({ width: ORB_A.size, height: ORB_A.size });
      expect(b).toMatchObject({ width: ORB_B.size, height: ORB_B.size });
      // `--radius-full` -> radius.full. The source sets it on BOTH.
      expect(a.borderRadius).toBe(radius.full);
      expect(b.borderRadius).toBe(radius.full);
      // Absolute, or each orb would displace the other and the content beneath.
      expect(a.position).toBe('absolute');
      expect(b.position).toBe('absolute');
    });

    it('offsets each orb per the source', async () => {
      const { a, b } = orbStyles(await render(<AmbientOrbs category="instrumental" />));
      // A: top 10%, right -10%. B: bottom 20%, left -5%. The negatives are the
      // point — they push the orb past the card edge, where the clip cuts it.
      expect(a).toMatchObject({ top: '10%', right: '-10%' });
      expect(b).toMatchObject({ bottom: '20%', left: '-5%' });
      // Neither carries the other's edge. Naming an unconstrained axis does not
      // fail — it silently drops that edge's placement.
      expect(a).not.toHaveProperty('bottom');
      expect(b).not.toHaveProperty('top');
    });
  });

  describe('colour — derived from the clip category', () => {
    it('tints both orbs from categoryColor, with the source alpha per orb', async () => {
      const { a, b } = orbStyles(await render(<AmbientOrbs category="instrumental" />));
      const base = categoryColor('instrumental');
      // `${c}08` and `${c}0A` — two DIFFERENT hex alpha bytes. Not a scale label,
      // and not a rounding of each other.
      expect(a.backgroundColor).toBe(tintColor(base, ORB_A.step));
      expect(b.backgroundColor).toBe(tintColor(base, ORB_B.step));
      // Spelled out literally, so this pins the actual byte values instead of
      // re-deriving them through the same helper the component itself calls.
      expect(a.backgroundColor).toBe('rgba(0, 229, 160, 0.08)');
      expect(b.backgroundColor).toBe('rgba(0, 229, 160, 0.1)');
      expect(a.backgroundColor).not.toBe(b.backgroundColor);
    });

    it('changes with the category', async () => {
      const r = await render(<AmbientOrbs category="instrumental" />);
      const before = styleOf(node(r, 'ambient-orb-A')).backgroundColor;
      await r.rerender(<AmbientOrbs category="science" />);
      const after = styleOf(node(r, 'ambient-orb-A')).backgroundColor;
      expect(after).toBe(tintColor(categoryColor('science'), ORB_A.step));
      expect(after).not.toBe(before);
    });

    it('falls back to the neutral colour for a legacy or unknown category', async () => {
      // `AudioClip.category` is free text with no `choices` (models.py:112), so an
      // unrecognised value is a normal input, not an error. It must still render a
      // valid colour — `tint()` on an unvalidated string yields `rgba(…, NaN, …)`,
      // or worse, three real numbers that are simply the wrong colour.
      const { a, b } = orbStyles(await render(<AmbientOrbs category="Cyberpunk" />));
      expect(a.backgroundColor).toBe(tintColor(NEUTRAL_CATEGORY_COLOR, ORB_A.step));
      expect(b.backgroundColor).toBe(tintColor(NEUTRAL_CATEGORY_COLOR, ORB_B.step));
      expect(String(a.backgroundColor)).not.toMatch(/NaN/);
      expect(String(b.backgroundColor)).not.toMatch(/NaN/);
    });

    it('emits a valid rgba with no NaN channel for every category it can receive', async () => {
      // The prop is a CATEGORY, not a colour, so `categoryColor` — a total
      // function returning one of six literals — resolves it before `tintColor`
      // ever sees it. That makes an arbitrary hex like '#fff' UNREACHABLE as
      // input, and the interesting property is instead the one that holds across
      // the whole real domain: the 5 branded, the 6 legacy, an unknown string and
      // the empty value. `#fff` is only reachable if a future caller resolves the
      // colour itself, and `tintColor` is what makes that safe — see the
      // component's docstring.
      for (const category of [
        ...BRANDED_CATEGORIES.map((c) => c.value),
        ...LEGACY_CATEGORIES,
        'not-a-real-category',
        '',
      ]) {
        const { a, b } = orbStyles(await render(<AmbientOrbs category={category} />));
        for (const color of [a.backgroundColor, b.backgroundColor]) {
          expect(String(color)).toMatch(
            /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (0\.0?\d+|1)\)$/,
          );
        }
        // And the two orbs keep distinct alpha steps whatever the base colour is.
        expect(a.backgroundColor).not.toBe(b.backgroundColor);
      }
    });
  });

  describe('blur — emitted shape only (see the header: rendering is untestable here)', () => {
    it('emits a single-primitive array carrying a non-negative numeric blur', async () => {
      const { a, b } = orbStyles(await render(<AmbientOrbs category="instrumental" />));

      // Exact deep equality: ONE element, ONE key, a NUMBER. The string form
      // ('blur(60px)') fails this — which is the point. This file uses the array
      // form exclusively, and the array form is what makes a bare number legal.
      expect(a.filter).toEqual([{ blur: ORB_A.blur }]);
      expect(b.filter).toEqual([{ blur: ORB_B.blur }]);

      for (const filter of [a.filter, b.filter]) {
        expect(Array.isArray(filter)).toBe(true);
        const arr = filter as Array<Record<string, unknown>>;
        // `processFilter` returns [] for the WHOLE array if any single primitive
        // is bad, so length here is load-bearing, not cosmetic.
        expect(arr).toHaveLength(1);
        expect(Object.keys(arr[0]!)).toHaveLength(1);
        const amount = arr[0]!.blur;
        // A number, never a string: a string takes the unit-parsing path
        // (processFilter.js:139-146), where a non-`px` unit returns undefined and
        // discards the entire filter.
        expect(typeof amount).toBe('number');
        expect(Number.isFinite(amount)).toBe(true);
        expect(amount as number).toBeGreaterThanOrEqual(0);
      }
    });

    it('uses a different blur radius per orb', async () => {
      // Guards against both orbs collapsing onto one shared value — a copy-paste
      // that looks right and quietly loses the 40/60 contrast the source has.
      const { a, b } = orbStyles(await render(<AmbientOrbs category="instrumental" />));
      expect(a.filter).not.toEqual(b.filter);
    });
  });

  describe('non-interactive and decorative', () => {
    it('is hidden from assistive technology', async () => {
      const r = await render(<AmbientOrbs category="instrumental" />);
      // Asserted on the ORBS, not only the container: the question is whether a
      // screen reader reaches these two views, and the container's flag only
      // answers that if inheritance holds. Uses RNTL's own semantic helper
      // (helpers/accessibility.js:30-49), which walks the tree and honours
      // `aria-hidden`, `accessibilityElementsHidden`, `importantForAccessibility`
      // and `display: none` — so it stays correct whichever way RN resolves the
      // prop, rather than asserting one spelling of it.
      expect(isHiddenFromAccessibility(node(r, 'ambient-orb-A'))).toBe(true);
      expect(isHiddenFromAccessibility(node(r, 'ambient-orb-B'))).toBe(true);
      expect(isHiddenFromAccessibility(node(r, 'ambient-orbs'))).toBe(true);
    });

    it('cannot swallow a tap aimed at the card', async () => {
      const r = await render(<AmbientOrbs category="instrumental" />);
      // These are up to 280px of blurred circle laid over the card's play target.
      // `pointerEvents="none"` is the control that stops them eating it, and it
      // sits on the container so it holds for both orbs.
      expect(node(r, 'ambient-orbs').props.pointerEvents).toBe('none');
    });

    it('exposes no accessibility label or role of its own', async () => {
      const r = await render(<AmbientOrbs category="instrumental" />);
      const p = node(r, 'ambient-orbs').props as Record<string, unknown>;
      expect(p.accessibilityLabel).toBeUndefined();
      expect(p.accessibilityRole).toBeUndefined();
    });
  });
});
