/**
 * Test doubles for `<audio>`.
 *
 * jsdom does not implement media playback: `new Audio()` constructs, but
 * `play()` throws "Not implemented" and `currentTime` never moves, so any test
 * touching the player store hangs on a timer or asserts nothing. `MockAudio`
 * is a controllable stand-in: tests drive playback position explicitly and can
 * fire the real `timeupdate` / `seeked` / `ended` events the store listens for.
 *
 * Install via `src/setupTests.ts`. Retrieve instances with `getAudioInstances()`.
 */

export type AudioState = "idle" | "playing" | "paused" | "ended";

export class MockAudio extends EventTarget {
  static instances: MockAudio[] = [];

  currentTime = 0;
  duration = Number.NaN;
  playbackRate = 1;
  volume = 1;
  crossOrigin: string | null = null;
  src = "";
  preload = "auto";
  loop = false;
  muted = false;
  readyState = 0; // HAVE_NOTHING
  networkState = 0; // NETWORK_EMPTY
  error: MediaError | null = null;
  state: AudioState = "idle";

  /** Every `play()` call, in order. Lets a test assert an autoplay was attempted. */
  playCalls = 0;

  constructor(src = "") {
    super();
    this.src = src;
    MockAudio.instances.push(this);
  }

  get paused(): boolean {
    return this.state !== "playing";
  }

  get buffered(): TimeRanges {
    return { length: 0, start: () => 0, end: () => 0 } as unknown as TimeRanges;
  }

  get seekable(): TimeRanges {
    return { length: 0, start: () => 0, end: () => 0 } as unknown as TimeRanges;
  }

  play(): Promise<void> {
    this.playCalls += 1;
    this.readyState = 4; // HAVE_ENOUGH_DATA
    this.state = "playing";
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  }

  pause(): void {
    if (this.state === "paused") return;
    this.state = "paused";
    this.dispatchEvent(new Event("pause"));
  }

  load(): void {
    this.networkState = 2; // NETWORK_LOADING
  }

  removeAttribute(_name: string): void {
    /* no-op */
  }

  setAttribute(name: string, value: string): void {
    if (name === "src") this.src = value;
  }

  addTextTrack(): null {
    return null;
  }

  canPlayType(): string {
    return "";
  }

  // -- test controls -------------------------------------------------------

  /** Fire a real `timeupdate`, as a browser would during playback. */
  emitTimeUpdate(): void {
    this.dispatchEvent(new Event("timeupdate"));
  }

  /** Fire a real `seeked`, as a browser would after a scrub. */
  emitSeeked(): void {
    this.dispatchEvent(new Event("seeked"));
  }

  /**
   * Advance the media position to `seconds`, optionally simulating a seek.
   * `seeking`/`seeked` fire only when the position actually jumps.
   */
  advanceTo(seconds: number, options: { seek?: boolean; emitTimeUpdate?: boolean } = {}): void {
    const { seek = true, emitTimeUpdate = true } = options;
    const jumped = Math.abs(seconds - this.currentTime) > 0.01;
    this.currentTime = seconds;
    if (seek && jumped) {
      this.dispatchEvent(new Event("seeking"));
      this.dispatchEvent(new Event("seeked"));
    }
    if (emitTimeUpdate) this.emitTimeUpdate();
  }

  /** Simulate reaching the end of the clip. */
  end(): void {
    this.state = "ended";
    this.dispatchEvent(new Event("ended"));
  }

  /** Simulate a decode/load failure. */
  fail(code: number = 3): void {
    this.error = { code, message: "mock decode failure" } as MediaError;
    this.networkState = 3; // NETWORK_NO_SOURCE
    this.dispatchEvent(new Event("error"));
  }
}

/**
 * Typed constructor for tests.
 *
 * `new Audio()` is typed as `HTMLAudioElement` by the DOM lib, so the test
 * controls (`advanceTo`, `end`, `fail`) would be invisible to the compiler.
 * Production code uses the global; tests use this.
 */
export function createMockAudio(src = ""): MockAudio {
  return new MockAudio(src);
}

export function getAudioInstances(): MockAudio[] {
  return MockAudio.instances;
}

export function getLastAudio(): MockAudio | undefined {
  return MockAudio.instances[MockAudio.instances.length - 1];
}

export function resetAudioInstances(): void {
  MockAudio.instances = [];
}

/** Assign `duration` and fire `loadedmetadata`, as a browser would on manifest load. */
export function setAudioDuration(audio: MockAudio, seconds: number): void {
  audio.duration = seconds;
  audio.readyState = 4;
  audio.dispatchEvent(new Event("loadedmetadata"));
  audio.dispatchEvent(new Event("durationchange"));
}
