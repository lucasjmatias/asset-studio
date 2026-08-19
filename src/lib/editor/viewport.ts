import type { PixelResizeMode } from "./model";

export type Point = { x: number; y: number };

export function clampCanvasZoom(value: number): number {
  return Math.max(0.25, Math.min(4, value));
}

export function zoomPanAroundAnchor(
  currentZoom: number,
  requestedZoom: number,
  currentPan: Point,
  anchor: Point,
  viewportOrigin: Point,
): { zoom: number; pan: Point } {
  const zoom = clampCanvasZoom(requestedZoom);
  const ratio = zoom / Math.max(0.25, currentZoom);
  return {
    zoom,
    pan: {
      x: anchor.x - viewportOrigin.x - (anchor.x - viewportOrigin.x - currentPan.x) * ratio,
      y: anchor.y - viewportOrigin.y - (anchor.y - viewportOrigin.y - currentPan.y) * ratio,
    },
  };
}

export function outputPixelDelta(
  viewBox: [number, number, number, number],
  output: { width: number; height: number },
  resizeMode: PixelResizeMode,
  pixels: Point,
): Point {
  const width = Math.max(1, output.width);
  const height = Math.max(1, output.height);
  if (resizeMode === "contain") {
    const scale = Math.max(1e-6, Math.min(width / viewBox[2], height / viewBox[3]));
    return { x: pixels.x / scale, y: pixels.y / scale };
  }
  return {
    x: pixels.x * viewBox[2] / width,
    y: pixels.y * viewBox[3] / height,
  };
}
