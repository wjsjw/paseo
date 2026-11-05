import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAnchorMeasurement,
  INTELLIJ_VIEWPORT_CHANGE_EVENT,
  subscribeToAnchorViewport,
} from "./combobox-anchor-viewport";

const scheduledFrames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;
let canceledFrames: number[] = [];
let viewport: EventTarget;
let visualViewport: EventTarget;

function dispatch(target: EventTarget, type: string) {
  target.dispatchEvent(new Event(type));
}

function installViewport(): void {
  viewport = new EventTarget();
  visualViewport = new EventTarget();
  Object.defineProperty(viewport, "visualViewport", { value: visualViewport });
  vi.stubGlobal("window", viewport);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrameId += 1;
    scheduledFrames.set(nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (frameId: number) => {
    canceledFrames.push(frameId);
    scheduledFrames.delete(frameId);
  });
}

function flushFrames(): void {
  const frames = [...scheduledFrames.entries()];
  scheduledFrames.clear();
  for (const [, callback] of frames) callback(0);
}

afterEach(() => {
  vi.unstubAllGlobals();
  scheduledFrames.clear();
  canceledFrames = [];
  nextFrameId = 0;
});

describe("createAnchorMeasurement", () => {
  it("ignores an older measurement when a newer one completes first", () => {
    const callbacks: Array<(x: number, y: number, width: number, height: number) => void> = [];
    const onMeasurement = vi.fn();
    const measurement = createAnchorMeasurement(
      (callback) => callbacks.push(callback),
      onMeasurement,
    );

    measurement.measure();
    measurement.measure();
    callbacks[0](10, 20, 100, 30);
    callbacks[1](15, 25, 120, 40);

    expect(onMeasurement).toHaveBeenCalledExactlyOnceWith({ x: 15, y: 25, width: 120, height: 40 });
  });

  it("ignores invalid geometry and callbacks after disposal", () => {
    const callbacks: Array<(x: number, y: number, width: number, height: number) => void> = [];
    const onMeasurement = vi.fn();
    const measurement = createAnchorMeasurement(
      (callback) => callbacks.push(callback),
      onMeasurement,
    );

    measurement.measure();
    callbacks[0](0, 0, 0, 40);
    measurement.measure();
    measurement.dispose();
    callbacks[1](10, 20, 100, 30);

    expect(onMeasurement).not.toHaveBeenCalled();
  });
});

describe("subscribeToAnchorViewport", () => {
  it("coalesces viewport and IntelliJ host changes into one animation frame", () => {
    installViewport();
    const onChange = vi.fn();
    subscribeToAnchorViewport(onChange);

    dispatch(viewport, "resize");
    dispatch(viewport, "scroll");
    dispatch(visualViewport, "resize");
    dispatch(viewport, INTELLIJ_VIEWPORT_CHANGE_EVENT);

    expect(scheduledFrames.size).toBe(1);
    flushFrames();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("removes listeners and cancels a queued measurement on cleanup", () => {
    installViewport();
    const onChange = vi.fn();
    const unsubscribe = subscribeToAnchorViewport(onChange);

    dispatch(viewport, "resize");
    unsubscribe();
    flushFrames();
    dispatch(viewport, "resize");
    flushFrames();

    expect(onChange).not.toHaveBeenCalled();
    expect(canceledFrames).toEqual([1]);
  });
});
