import {
  clampIndex,
  clipIdAtIndex,
  indexFromOffset,
  itemLayout,
  unambiguousViewableId,
} from '../feedViewport';

describe('indexFromOffset', () => {
  it('rounds to the nearest page', () => {
    expect(indexFromOffset(0, 800)).toBe(0);
    expect(indexFromOffset(790, 800)).toBe(1);
    expect(indexFromOffset(410, 800)).toBe(1);
    expect(indexFromOffset(1580, 800)).toBe(2);
  });

  it('returns null before the viewport is measured', () => {
    // An unmeasured list must not resolve to index 0 by accident, or the app
    // loads reel 0 for a screenful the user never saw.
    expect(indexFromOffset(0, 0)).toBeNull();
    expect(indexFromOffset(500, -1)).toBeNull();
    expect(indexFromOffset(NaN, 800)).toBeNull();
  });

  it('never returns a negative index from an over-scroll', () => {
    // Pulling down at the top produces a negative contentOffset.
    expect(indexFromOffset(-120, 800)).toBe(0);
  });
});

describe('clipIdAtIndex', () => {
  const ids = ['a', 'b', 'c'];

  it('resolves a settled index', () => {
    expect(clipIdAtIndex(ids, 1)).toBe('b');
  });

  it('returns null past the end, so a bounce cannot load a clip', () => {
    // iOS over-scrolls at the end of a paging list. Resolving index 3 of 3
    // items would load a clip that is not on screen.
    expect(clipIdAtIndex(ids, 3)).toBeNull();
    expect(clipIdAtIndex(ids, 99)).toBeNull();
  });

  it('returns null for a null index', () => {
    expect(clipIdAtIndex(ids, null)).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(clipIdAtIndex([], 0)).toBeNull();
  });
});

describe('unambiguousViewableId', () => {
  // The viewability latch. With a 70% threshold both the outgoing and
  // incoming reel are viewable mid-snap, and `viewableItems` is not ordered by
  // prominence, so `viewableItems[0]` can be the reel the user is leaving.
  it('ignores a mid-snap event with two items visible', () => {
    expect(unambiguousViewableId(['a', 'b'])).toBeNull();
  });

  it('accepts the single at-rest item', () => {
    expect(unambiguousViewableId(['b'])).toBe('b');
  });

  it('ignores an empty event', () => {
    expect(unambiguousViewableId([])).toBeNull();
  });
});

describe('itemLayout', () => {
  it('pages by the measured viewport', () => {
    expect(itemLayout(800, 0)).toEqual({ length: 800, offset: 0, index: 0 });
    expect(itemLayout(800, 3)).toEqual({ length: 800, offset: 2400, index: 3 });
  });

  it('uses the measured height, not the window height', () => {
    // The tab bar is 100px, so a reel is window.height - 100. Sizing cells
    // from the window makes the last page unreachable and shifts every offset.
    const window = 900;
    const nav = 100;
    expect(itemLayout(window - nav, 1).offset).toBe(800);
  });
});

describe('clampIndex', () => {
  it('clamps into range', () => {
    expect(clampIndex(2, 5)).toBe(2);
    expect(clampIndex(99, 5)).toBe(4);
    expect(clampIndex(-4, 5)).toBe(0);
  });

  it('returns null for an empty list', () => {
    // `onScrollToIndexFailed` recovery: retrying out of range verbatim can
    // fail identically forever, and with nothing to scroll to there is no
    // sensible index.
    expect(clampIndex(0, 0)).toBeNull();
    expect(clampIndex(3, -1)).toBeNull();
  });

  it('returns null for a non-finite index', () => {
    expect(clampIndex(NaN, 5)).toBeNull();
  });

  it('truncates a fractional index', () => {
    expect(clampIndex(2.7, 5)).toBe(2);
  });
});
