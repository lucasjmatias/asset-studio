import { describe, expect, it } from "vitest";

import { addPathNodeAfter, configurePathNode, movePathHandle, nodeIndexForHandle, parsePathData, pathArea, pathHandles, removePathNode, serializePathData } from "./shape";

describe("non-destructive vector paths", () => {
  it("normalizes relative and smooth commands into editable absolute commands", () => {
    const commands = parsePathData("m10 10 c10 0 20 10 30 10 s20 -10 30 0 z");
    expect(commands.map((command) => command.type)).toEqual(["M", "C", "C", "Z"]);
    expect(commands[2].values.slice(0, 2)).toEqual([50, 20]);
    expect(serializePathData(commands)).toContain("C50 20 60 10 70 20");
  });

  it("moves an anchor and its adjacent controls as one coherent node", () => {
    const commands = parsePathData("M0 0 C0 10 10 10 10 0 C10 -10 20 -10 20 0 Z");
    const anchor = pathHandles(commands).find((handle) => handle.id === "1:anchor");
    expect(anchor).toBeDefined();
    const moved = movePathHandle(commands, anchor!, 12, 3);
    expect(moved[1].values.slice(2)).toEqual([12, 13, 12, 3]);
    expect(moved[2].values.slice(0, 2)).toEqual([12, -7]);
  });

  it("reports area as a stable source-relative volume basis", () => {
    const source = parsePathData("M0 0 L10 0 L10 10 L0 10 Z");
    const smaller = parsePathData("M0 0 L9 0 L9 10 L0 10 Z");
    expect(pathArea(source)).toBeCloseTo(100, 6);
    expect(pathArea(smaller) / pathArea(source) * 100).toBeCloseTo(90, 6);
  });

  it("inserts a cubic node without changing the curve or volume", () => {
    const commands = parsePathData("M0 0 C0 10 10 10 10 0 L0 0 Z");
    const added = addPathNodeAfter(commands, 0);
    expect(added?.nodeIndex).toBe(1);
    expect(added?.commands.filter((command) => command.type === "C")).toHaveLength(2);
    expect(pathArea(added!.commands)).toBeCloseTo(pathArea(commands), 5);
  });

  it("supports corner, smooth, and smart puller behavior", () => {
    const source = parsePathData("M0 0 L10 10 L20 0 L0 0 Z");
    const smooth = configurePathNode(source, 1, "smooth");
    expect(smooth[1].type).toBe("C");
    expect(smooth[2].type).toBe("C");
    const outgoing = pathHandles(smooth).find((handle) => handle.id === "2:control-1")!;
    const independent = movePathHandle(smooth, outgoing, 15, 12, "smooth");
    expect(independent[1].values.slice(2, 4)).toEqual(smooth[1].values.slice(2, 4));

    const moved = movePathHandle(smooth, outgoing, 15, 12, "smart");
    const anchor = { x: moved[1].values[4], y: moved[1].values[5] };
    const incomingLength = Math.hypot(moved[1].values[2] - anchor.x, moved[1].values[3] - anchor.y);
    const outgoingLength = Math.hypot(moved[2].values[0] - anchor.x, moved[2].values[1] - anchor.y);
    expect(incomingLength).toBeCloseTo(outgoingLength, 6);

    const corner = configurePathNode(moved, 1, "sharp");
    expect(corner[1].values.slice(2, 4)).toEqual([anchor.x, anchor.y]);
    expect(corner[2].values.slice(0, 2)).toEqual([anchor.x, anchor.y]);
  });

  it("removes a selected node but protects the minimum shape", () => {
    const square = parsePathData("M0 0 L10 0 L10 10 L0 10 Z");
    expect(removePathNode(square, 2)?.commands.filter((command) => command.type !== "Z")).toHaveLength(3);
    const triangle = parsePathData("M0 0 L10 0 L5 10 Z");
    expect(removePathNode(triangle, 1)).toBeNull();
  });

  it("always exposes two pullers at both sides of a closed-path seam", () => {
    const square = parsePathData("M0 0 L10 0 L10 10 L0 10 Z");
    const firstSmooth = configurePathNode(square, 0, "smooth");
    const firstHandles = pathHandles(firstSmooth);
    expect(firstHandles.filter((handle) => handle.kind === "anchor")).toHaveLength(4);
    expect(firstHandles.filter((handle) => handle.kind === "control" && nodeIndexForHandle(firstSmooth, handle) === 0)).toHaveLength(2);

    const lastSmooth = configurePathNode(square, 3, "smooth");
    expect(pathHandles(lastSmooth).filter((handle) => handle.kind === "control" && nodeIndexForHandle(lastSmooth, handle) === 3)).toHaveLength(2);
    expect(pathArea(firstSmooth)).toBeCloseTo(pathArea(square), 6);
    expect(pathArea(lastSmooth)).toBeCloseTo(pathArea(square), 6);
  });
});
