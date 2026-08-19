import { describe, expect, it } from "vitest";

import { outputPixelDelta, zoomPanAroundAnchor } from "./viewport";

describe("canvas navigation", () => {
  it("keeps the canvas point under the wheel cursor while zooming", () => {
    const result = zoomPanAroundAnchor(1, 2, { x: 20, y: -10 }, { x: 250, y: 160 }, { x: 100, y: 100 });
    expect(result).toEqual({ zoom: 2, pan: { x: -110, y: -80 } });
    const localBefore = { x: (250 - 100 - 20) / 1, y: (160 - 100 + 10) / 1 };
    const localAfter = { x: (250 - 100 - result.pan.x) / result.zoom, y: (160 - 100 - result.pan.y) / result.zoom };
    expect(localAfter).toEqual(localBefore);
  });

  it("moves one contain-mode output pixel equally in both root axes", () => {
    expect(outputPixelDelta([0, 0, 512, 256], { width: 96, height: 48 }, "contain", { x: 1, y: -1 }))
      .toEqual({ x: 16 / 3, y: -16 / 3 });
  });

  it("uses independent output axes in stretch mode", () => {
    expect(outputPixelDelta([0, 0, 400, 200], { width: 100, height: 100 }, "stretch", { x: 2, y: -3 }))
      .toEqual({ x: 8, y: -6 });
  });
});
