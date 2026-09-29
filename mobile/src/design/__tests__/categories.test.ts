import {
  ALL_CATEGORIES,
  BRANDED_CATEGORIES,
  LEGACY_CATEGORIES,
  NEUTRAL_CATEGORY_COLOR,
  categoryColor,
  categoryLabel,
  isBrandedCategory,
} from '../categories';
import { content } from '../tokens';

/**
 * Decision O2 tests. The rule is "5 branded, everything else neutral" — the
 * value here is proving the *fallback* works, because `category` is free text
 * (`models.py:112`, no `choices`) so an unrecognised string is a normal input,
 * not an error.
 */
describe('category taxonomy (O2)', () => {
  it('offers all 5 branded and all 6 legacy values in the picker', () => {
    expect(ALL_CATEGORIES).toHaveLength(11);
    expect(ALL_CATEGORIES.slice(0, 5)).toEqual(BRANDED_CATEGORIES.map((c) => c.value));
    expect(ALL_CATEGORIES.slice(5)).toEqual([...LEGACY_CATEGORIES]);
  });

  it('gives each branded category a distinct colour', () => {
    const colors = BRANDED_CATEGORIES.map((c) => c.color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('colours every legacy value neutrally', () => {
    // The whole point of the union: stored legacy rows get a colour without
    // needing a per-value entry.
    for (const value of LEGACY_CATEGORIES) {
      expect(categoryColor(value)).toBe(NEUTRAL_CATEGORY_COLOR);
      expect(isBrandedCategory(value)).toBe(false);
    }
  });

  it('falls back to neutral for an unknown value', () => {
    // Not an error path — a scraped clip or a future backend value.
    expect(categoryColor('Krautrock')).toBe(NEUTRAL_CATEGORY_COLOR);
    expect(categoryLabel('Krautrock')).toBe('Krautrock');
  });

  it('falls back to neutral for null and undefined', () => {
    expect(categoryColor(null)).toBe(NEUTRAL_CATEGORY_COLOR);
    expect(categoryColor(undefined)).toBe(NEUTRAL_CATEGORY_COLOR);
    expect(categoryLabel(null)).toBe('Uncategorised');
  });

  it('uses --outline as the neutral, so no new colour enters the system', () => {
    expect(NEUTRAL_CATEGORY_COLOR).toBe(content.tertiary);
  });

  it('is case-sensitive, matching the backend\'s exact-match filter', () => {
    // /suggestions/?category= compares for equality, so 'Instrumental' must not
    // resolve to the branded colour — that would show the right colour for a
    // query that returns nothing.
    expect(categoryColor('Instrumental')).toBe(NEUTRAL_CATEGORY_COLOR);
    expect(categoryColor('instrumental')).not.toBe(NEUTRAL_CATEGORY_COLOR);
  });
});
