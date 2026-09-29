/**
 * Reel geometry, as pure functions.
 *
 * Extracted for the same reason `lib/feedBuffer.ts` and
 * `lib/playbackDecision.ts` are: the two bugs in this file were properties of a
 * *computation*, not of React, so they are testable directly.
 */

/**
 * Which reel is on screen, given a scroll offset.
 *
 * The FlatList pages by whole viewport, so the settled index is the offset
 * rounded to the nearest page. Derived from `onMomentumScrollEnd` rather than
 * from viewability, because `onViewableItemsChanged` is ambiguous mid-snap:
 * with `itemVisiblePercentThreshold: 70` BOTH the outgoing and incoming reel
 * exceed the threshold, and `viewableItems` is not ordered by prominence, so
 * `viewableItems[0]` can be the reel the user is leaving. That fires an
 * extra `replace()` + token mint and briefly shows the wrong clip's card.
 *
 * Returns `null` when the geometry is not yet known, so an unmeasured list
 * never resolves to a bogus index.
 */
export function indexFromOffset(offsetY: number, viewportHeight: number): number | null {
  if (!Number.isFinite(offsetY) || viewportHeight <= 0) return null;
  const raw = Math.round(offsetY / viewportHeight);
  return Math.max(0, raw);
}

/**
 * The single clip id at `index`, or null.
 *
 * The clamp matters: a bounce at the end of the list produces an offset past
 * the last page, and resolving that to a clip id would load a clip that is not
 * on screen.
 */
export function clipIdAtIndex(ids: readonly string[], index: number | null): string | null {
  if (index === null || index < 0 || index >= ids.length) return null;
  return ids[index] ?? null;
}

/**
 * Whether a viewability event is unambiguous enough to act on.
 *
 * Only accepted when exactly one item is viewable — i.e. at rest. Mid-snap
 * there are two, and guessing between them is the bug. Returns the id to
 * select, or `null` to ignore the event.
 */
export function unambiguousViewableId(viewableIds: readonly string[]): string | null {
  return viewableIds.length === 1 ? viewableIds[0] ?? null : null;
}

/**
 * Clamp an index into a list of `length`.
 *
 * Used for the `onScrollToIndexFailed` recovery: RN reports the index it could
 * not reach, and retrying that verbatim can fail identically forever if it is
 * out of range. Returns `null` when the list is empty, so there is nothing to
 * scroll to.
 */
export function clampIndex(index: number, length: number): number | null {
  if (length <= 0) return null;
  if (!Number.isFinite(index)) return null;
  return Math.min(Math.max(0, Math.trunc(index)), length - 1);
}

/**
 * `getItemLayout` body.
 *
 * Without this FlatList cannot page, scroll to an index, or know an item's
 * bounds, and it falls back to measuring every cell — which for full-bleed
 * reels means a blank frame per item on first layout. `length` must be the
 * *measured* height, not `window.height`: the tab bar is 100px
 * (`layout.navClearance`), so a reel is not the window.
 */
export function itemLayout(
  viewportHeight: number,
  index: number,
): { length: number; offset: number; index: number } {
  return { length: viewportHeight, offset: viewportHeight * index, index };
}
