import { describe, expect, it } from "vitest";
import { createMockAudio, getLastAudio, MockAudio, setAudioDuration } from "./mediaMock";

/**
 * Guards the harness itself. Every later commit's player, telemetry and share
 * tests stand on these doubles, so a silent regression here (a jsdom gap that
 * reappears, or a double that stops firing real events) would show up as a
 * dozen unrelated failures.
 */
describe("MockAudio", () => {
  it("is installed as the global Audio constructor", () => {
    expect(new Audio()).toBeInstanceOf(MockAudio);
  });

  it("records every instance in creation order", () => {
    const first = createMockAudio();
    const second = createMockAudio();
    expect(getLastAudio()).toBe(second);
    expect(first).not.toBe(second);
  });

  it("fires a real play event and flips paused", async () => {
    const audio = createMockAudio();
    const seen: string[] = [];
    audio.addEventListener("play", () => seen.push("play"));

    expect(audio.paused).toBe(true);
    await audio.play();

    expect(seen).toEqual(["play"]);
    expect(audio.paused).toBe(false);
    expect(audio.playCalls).toBe(1);
  });

  it("emits timeupdate on advanceTo", () => {
    const audio = createMockAudio();
    const seen: string[] = [];
    audio.addEventListener("timeupdate", () => seen.push("timeupdate"));

    audio.advanceTo(3);

    expect(audio.currentTime).toBe(3);
    expect(seen).toEqual(["timeupdate"]);
  });

  it("emits seeking/seeked only when the position jumps", () => {
    const audio = createMockAudio();
    const seen: string[] = [];
    audio.addEventListener("seeking", () => seen.push("seeking"));
    audio.addEventListener("seeked", () => seen.push("seeked"));

    // Natural playback progression: no seek events.
    audio.advanceTo(0.25, { seek: false });
    expect(seen).toEqual([]);

    // A real seek: both events fire.
    audio.advanceTo(120, { seek: true });
    expect(seen).toEqual(["seeking", "seeked"]);
    expect(audio.currentTime).toBe(120);
  });

  it("can emit timeupdate without firing a seek", () => {
    const audio = createMockAudio();
    const seen: string[] = [];
    audio.addEventListener("seeking", () => seen.push("seeking"));
    audio.addEventListener("timeupdate", () => seen.push("timeupdate"));

    audio.advanceTo(1, { seek: false });

    expect(seen).toEqual(["timeupdate"]);
  });

  it("emits ended", () => {
    const audio = createMockAudio();
    const seen: string[] = [];
    audio.addEventListener("ended", () => seen.push("ended"));

    audio.end();

    expect(seen).toEqual(["ended"]);
    expect(audio.paused).toBe(true);
  });

  it("emits error on failure", () => {
    const audio = createMockAudio();
    const seen: string[] = [];
    audio.addEventListener("error", () => seen.push("error"));

    audio.fail();

    expect(seen).toEqual(["error"]);
    expect(audio.error?.code).toBe(3);
  });

  it("emits duration metadata", () => {
    const audio = createMockAudio();
    const seen: string[] = [];
    audio.addEventListener("loadedmetadata", () => seen.push("loadedmetadata"));

    setAudioDuration(audio, 600);

    expect(audio.duration).toBe(600);
    expect(seen).toEqual(["loadedmetadata"]);
  });
});
