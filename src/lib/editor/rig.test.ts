import { describe, expect, it } from "vitest";

import {
  composeBoneTransform,
  identityBoneTransform,
  relativeBoneTransform,
  type Bone,
  type BonePoseTransform,
} from "./model";
import { boneGroupMatrices, boneWorldMap, type Matrix } from "./rig";

const bone: Bone = {
  id: "root",
  name: "Root",
  parentId: null,
  groupKey: "art",
  x: 10,
  y: 20,
  length: 40,
  restRotation: 15,
};

const setup: BonePoseTransform = {
  x: 3,
  y: -4,
  rotation: 22,
  scaleX: 1,
  scaleY: 1,
};

function mapPoint(matrix: Matrix, x: number, y: number) {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  };
}

function expectPoint(actual: { x: number; y: number }, expected: { x: number; y: number }) {
  expect(actual.x).toBeCloseTo(expected.x, 8);
  expect(actual.y).toBeCloseTo(expected.y, 8);
}

describe("rig setup baseline", () => {
  it("does not deform artwork when a pose has no delta", () => {
    const effective = composeBoneTransform(setup, identityBoneTransform());
    const delta = boneGroupMatrices([bone], { root: effective }, { root: setup }).art;
    [1, 0, 0, 1, 0, 0].forEach((value, index) => expect(delta[index]).toBeCloseTo(value, 10));
  });

  it("round-trips effective transforms through independent pose deltas", () => {
    const effective = { ...setup, x: 18, y: 7, rotation: -31, scaleX: 1.4, scaleY: 0.7 };
    const pose = relativeBoneTransform(effective, setup);
    expect(composeBoneTransform(setup, pose)).toEqual(effective);
  });
});

describe("bone endpoint pivots", () => {
  it("keeps the start fixed while the end rotates", () => {
    const rest = boneWorldMap([bone], { root: setup }).root;
    const effective = { ...setup, rotation: setup.rotation + 90 };
    const delta = boneGroupMatrices([bone], { root: effective }, { root: setup }).art;
    expectPoint(mapPoint(delta, rest.startX, rest.startY), { x: rest.startX, y: rest.startY });
  });

  it("keeps the end fixed while the start rotates", () => {
    const rest = boneWorldMap([bone], { root: setup }).root;
    const oldVector = { x: rest.endX - rest.startX, y: rest.endY - rest.startY };
    const nextStart = { x: rest.endX + oldVector.y, y: rest.endY - oldVector.x };
    const effective = {
      ...setup,
      x: nextStart.x - bone.x,
      y: nextStart.y - bone.y,
      rotation: setup.rotation + 90,
    };
    const delta = boneGroupMatrices([bone], { root: effective }, { root: setup }).art;
    expectPoint(mapPoint(delta, rest.endX, rest.endY), { x: rest.endX, y: rest.endY });
  });
});
