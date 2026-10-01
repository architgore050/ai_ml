/**
 * Category taxonomy — decision O2, owner-approved 2026-09-29.
 *
 * `AudioClip.category` is free text: `models.py:112` is
 * `CharField(max_length=50, blank=True)` with no `choices`, so the backend
 * accepts any string and the old 6 values are already stored in the DB.
 *
 * THE RULE, which collapses to a single case: **5 branded, everything else
 * neutral.** That covers the legacy values the old app wrote AND any unknown
 * value arriving from a future backend change or a scraped clip, so there is no
 * third case to enumerate and no per-value colour table to maintain.
 *
 * CRITICAL: `/suggestions/?category=` filters on **exact string equality**, so
 * these strings must be byte-identical to what is stored. A near-miss like
 * "Lo-Fi" vs "Lo-Fi Beats" is a *silently empty* result set, not a 400 — there
 * is no error to notice. This module is therefore the single source for the
 * upload picker, the suggestions filter pills and the colour lookup, so those
 * three views cannot disagree.
 *
 * @see frontend/sample_frontend2/src (design source, gitignored) for the 5
 *   branded categories and their colours; see the plan's §13 CATS line.
 * @see mobile/src/screens/UploadScreen.tsx:17-24 at commit 3aea96d for the 6
 *   legacy values (`git show 3aea96d:mobile/src/screens/UploadScreen.tsx`).
 */

import { brand, content } from './tokens';

/** The 5 categories the design source brands, with their palette colours. */
export const BRANDED_CATEGORIES = [
  { value: 'instrumental', label: 'Instrumental', color: '#00e5a0' },
  { value: 'funny', label: 'Funny', color: '#f59e0b' },
  { value: 'news', label: 'News', color: '#60a5fa' },
  { value: 'science', label: 'Science', color: '#8b5cf6' },
  { value: 'music', label: 'Music', color: '#ff6b35' },
] as const;

/**
 * The 6 values the old app wrote, which existing rows still carry. Spelled
 * exactly as `UploadScreen.tsx:17-24` had them. Coloured neutral (O2).
 */
export const LEGACY_CATEGORIES = [
  'Field Recordings',
  'Ambient & Drone',
  'Synthesizer',
  'Cyberpunk',
  'Lo-Fi Beats',
  'Speech & Poetry',
] as const;

/** Neutral colour for the legacy 6 and for any unknown value. O2. */
export const NEUTRAL_CATEGORY_COLOR = content.tertiary; // --outline #9d8e84

// Typed explicitly: `new Map(BRANDED_CATEGORIES.map(...))` infers its key type
// as the narrow literal union of the five values, so `BRANDED_MAP.get(someString)`
// is a type error for any other string — including the legacy values this whole
// module exists to handle.
const BRANDED_MAP: ReadonlyMap<string, (typeof BRANDED_CATEGORIES)[number]> = new Map(
  BRANDED_CATEGORIES.map((c) => [c.value, c] as const),
);

/**
 * Every value the upload picker offers, branded first then legacy — the
 * ordering O2 accepted as the cost of the union (11 rows).
 */
export const ALL_CATEGORIES: readonly string[] = [
  ...BRANDED_CATEGORIES.map((c) => c.value),
  ...LEGACY_CATEGORIES,
];

/**
 * Resolve a category string to its display colour. **Falls back to neutral**,
 * which is the whole point of O2: an unrecognised string is a normal
 * possibility here, not an error, because the field is free text.
 */
export function categoryColor(value: string | null | undefined): string {
  if (!value) return NEUTRAL_CATEGORY_COLOR;
  const branded = BRANDED_MAP.get(value);
  return branded ? branded.color : NEUTRAL_CATEGORY_COLOR;
}

/** Human label for a value, defaulting to the raw string (legacy pass-through). */
export function categoryLabel(value: string | null | undefined): string {
  if (!value) return 'Uncategorised';
  const branded = BRANDED_MAP.get(value);
  return branded ? branded.label : value;
}

/** True for the 5 the design source brands; false for legacy and unknown. */
export function isBrandedCategory(value: string | null | undefined): boolean {
  return !!value && BRANDED_MAP.has(value);
}
