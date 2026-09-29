import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { MockAudio, resetAudioInstances } from "./test/mediaMock";
import { installFetchMock } from "./test/fetchMock";

// ---------------------------------------------------------------------------
// <audio>
// ---------------------------------------------------------------------------
// jsdom's HTMLMediaElement throws "Not implemented" on play()/load(). The
// player store constructs `new Audio()` and calls play/pause freely, so the
// global constructor has to be a real double.
globalThis.Audio = MockAudio as unknown as typeof Audio;

beforeEach(() => {
  resetAudioInstances();
});

// ---------------------------------------------------------------------------
// IntersectionObserver
// ---------------------------------------------------------------------------
// `ReelList` installs one to detect the visible clip. jsdom has no layout, so
// no observer callback would ever fire and the feed would never advance.
// Tests trigger visibility explicitly via `intersectionMock.intersect(id)`.
class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = "";
  readonly thresholds: ReadonlyArray<number> = [];
  private readonly callback: IntersectionObserverCallback;
  private readonly targets = new Map<Element, number>();

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    intersectionMock.observers.push(this);
  }

  observe(target: Element): void {
    this.targets.set(target, 0);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /** Report `ratio` visibility for every element this observer is watching. */
  trigger(ratio = 1): void {
    const entries = [...this.targets.keys()].map(
      (target) =>
        ({
          target,
          isIntersecting: ratio > 0,
          intersectionRatio: ratio,
          boundingClientRect: target.getBoundingClientRect(),
          intersectionRect: target.getBoundingClientRect(),
          rootBounds: null,
          time: Date.now(),
        }) as IntersectionObserverEntry,
    );
    if (entries.length) this.callback(entries, this);
  }
}

const intersectionMock = {
  observers: [] as MockIntersectionObserver[],
  triggerAll(ratio = 1) {
    this.observers.forEach((o) => o.trigger(ratio));
  },
  reset() {
    this.observers.length = 0;
  },
};

globalThis.IntersectionObserver =
  MockIntersectionObserver as unknown as typeof IntersectionObserver;

beforeEach(() => {
  intersectionMock.reset();
});

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------
// Left un-routed: a request with no registered route 404s loudly rather than
// reaching the network, so an unmocked call is a failing test, not a hang.
const fetchMock = installFetchMock();

// ---------------------------------------------------------------------------
// Misc jsdom gaps
// ---------------------------------------------------------------------------
globalThis.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
})) as unknown as typeof matchMedia;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() {
  return false;
};
Element.prototype.setPointerCapture ??= function setPointerCapture() {};
Element.prototype.releasePointerCapture ??= function releasePointerCapture() {};

// jsdom implements neither, and both throw "not implemented" when called.
HTMLElement.prototype.scrollTo ??= function scrollTo() {};

// ---------------------------------------------------------------------------
// Per-test isolation
// ---------------------------------------------------------------------------
afterEach(() => {
  cleanup();
  fetchMock.reset();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
