export const INTELLIJ_VIEWPORT_CHANGE_EVENT = "paseo:intellij-viewport-change";

export interface AnchorMeasurement {
  x: number;
  y: number;
  width: number;
  height: number;
}

type MeasureInWindow = (
  callback: (x: number, y: number, width: number, height: number) => void,
) => void;

export function createAnchorMeasurement(
  measureInWindow: MeasureInWindow,
  onMeasurement: (measurement: AnchorMeasurement) => void,
) {
  let active = true;
  let measurementId = 0;

  return {
    measure() {
      const currentMeasurementId = ++measurementId;
      measureInWindow((x, y, width, height) => {
        if (!active || currentMeasurementId !== measurementId) return;
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
        onMeasurement({ x, y, width, height });
      });
    },
    dispose() {
      active = false;
      measurementId += 1;
    },
  };
}

export function subscribeToAnchorViewport(onChange: () => void): () => void {
  let scheduledFrame: number | null = null;

  const scheduleUpdate = () => {
    if (scheduledFrame !== null) return;
    scheduledFrame = requestAnimationFrame(() => {
      scheduledFrame = null;
      onChange();
    });
  };

  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("scroll", scheduleUpdate, true);
  window.addEventListener(INTELLIJ_VIEWPORT_CHANGE_EVENT, scheduleUpdate);
  window.visualViewport?.addEventListener("resize", scheduleUpdate);
  window.visualViewport?.addEventListener("scroll", scheduleUpdate);

  return () => {
    window.removeEventListener("resize", scheduleUpdate);
    window.removeEventListener("scroll", scheduleUpdate, true);
    window.removeEventListener(INTELLIJ_VIEWPORT_CHANGE_EVENT, scheduleUpdate);
    window.visualViewport?.removeEventListener("resize", scheduleUpdate);
    window.visualViewport?.removeEventListener("scroll", scheduleUpdate);
    if (scheduledFrame !== null) {
      cancelAnimationFrame(scheduledFrame);
      scheduledFrame = null;
    }
  };
}
