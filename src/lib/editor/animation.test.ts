import { describe, expect, it } from "vitest";

import { steppedPoseId, wrappedPoseNeighbors } from "./animation";

const poses = [{ id: "one" }, { id: "two" }, { id: "three" }];

describe("onion-skin pose neighbors", () => {
  it("wraps the first pose back to the last pose", () => {
    expect(wrappedPoseNeighbors(poses, "one")).toEqual({ previous: poses[2], next: poses[1] });
  });

  it("wraps the last pose forward to the first pose", () => {
    expect(wrappedPoseNeighbors(poses, "three")).toEqual({ previous: poses[1], next: poses[0] });
  });

  it("requires an active pose and at least two frames", () => {
    expect(wrappedPoseNeighbors([{ id: "one" }], "one")).toBeNull();
    expect(wrappedPoseNeighbors(poses, "rest")).toBeNull();
  });
});

describe("selection-free pose navigation", () => {
  it("steps and wraps in both directions", () => {
    expect(steppedPoseId(poses, "one", 1)).toBe("two");
    expect(steppedPoseId(poses, "three", 1)).toBe("one");
    expect(steppedPoseId(poses, "one", -1)).toBe("three");
  });

  it("enters from Rest at the edge matching the direction", () => {
    expect(steppedPoseId(poses, "rest", 1)).toBe("one");
    expect(steppedPoseId(poses, "rest", -1)).toBe("three");
    expect(steppedPoseId([], "rest", 1)).toBeNull();
  });
});
