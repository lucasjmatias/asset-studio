import { describe, expect, it } from "vitest";

import {
  composeBoneTransform,
  identityBoneTransform,
  relativeBoneTransform,
  type Bone,
  type BonePoseTransform,
} from "./model";
import { boneGroupMatrices, boneWorldMap, composeGroupLocalMatrices, dominantSampleOwner, fitBoneToGroupBounds, invertMatrix, multiplyMatrix, translateBoneEndpoints, type Matrix } from "./rig";

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
  it("moves both endpoints equally without changing length or parent geometry", () => {
    const child = { startX: 24, startY: 18, endX: 59, endY: 31 };
    const parent = { startX: 5, startY: 7, endX: 24, endY: 18 };
    const parentBefore = { ...parent };
    const beforeLength = Math.hypot(child.endX - child.startX, child.endY - child.startY);
    const moved = translateBoneEndpoints(child, { x: 11, y: -6 });

    expect(moved.start).toEqual({ x: 35, y: 12 });
    expect(moved.end).toEqual({ x: 70, y: 25 });
    expect(Math.hypot(moved.end.x - moved.start.x, moved.end.y - moved.start.y)).toBeCloseTo(beforeLength, 10);
    expect(parent).toEqual(parentBefore);
  });

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

describe("automatic group fitting", () => {
  it("centres along the longest shape axis and insets both ends", () => {
    const fit = fitBoneToGroupBounds({
      x: 10,
      y: 20,
      width: 100,
      height: 30,
      localToRoot: [1, 0, 0, 1, 5, -5],
    });

    expect(fit).not.toBeNull();
    expectPoint({ x: fit!.startX, y: fit!.startY }, { x: 23, y: 30 });
    expectPoint({ x: fit!.endX, y: fit!.endY }, { x: 107, y: 30 });
  });

  it("follows the visual axis of a rotated tall group", () => {
    const fit = fitBoneToGroupBounds({
      x: 0,
      y: 0,
      width: 20,
      height: 80,
      localToRoot: [0, 1, -1, 0, 200, 50],
    }, 0.1, 0);

    expect(fit).not.toBeNull();
    expectPoint({ x: fit!.startX, y: fit!.startY }, { x: 192, y: 60 });
    expectPoint({ x: fit!.endX, y: fit!.endY }, { x: 128, y: 60 });
  });

  it("preserves an existing diagonal direction for a round group", () => {
    const fit = fitBoneToGroupBounds({
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      localToRoot: [1, 0, 0, 1, 0, 0],
    }, 0.08, 0, { x: -1, y: 1 });

    expect(fit).not.toBeNull();
    expectPoint(
      { x: (fit!.startX + fit!.endX) / 2, y: (fit!.startY + fit!.endY) / 2 },
      { x: 20, y: 20 },
    );
    expect(fit!.endX - fit!.startX).toBeCloseTo(-(fit!.endY - fit!.startY), 9);
    expect(Math.hypot(fit!.endX - fit!.startX, fit!.endY - fit!.startY)).toBeCloseTo(33.6, 9);
  });
});

describe("automatic group binding", () => {
  it("selects a group only when it owns most bone samples", () => {
    expect(dominantSampleOwner([
      "hand", "hand", "hand", "hand", "hand", "hand", null, "arm", "arm", null,
    ])).toEqual({ key: "hand", coverage: 0.6 });
  });

  it("does not bind when no group reaches the overlap threshold", () => {
    expect(dominantSampleOwner(["hand", "hand", "arm", "arm", null])).toBeNull();
  });
});

describe("nested SVG group rigging", () => {
  const parentGroup = { key: "parent", label: "Arm", sourceId: "arm", parentKey: null, depth: 0 };
  const childGroup = { key: "child", label: "Hand", sourceId: "hand", parentKey: "parent", depth: 1 };
  const identity: Matrix = [1, 0, 0, 1, 0, 0];
  const parentRest: Matrix = [1, 0, 0, 1, 20, 5];
  const quarterTurn: Matrix = [0, 1, -1, 0, 35, -10];

  it("factors inherited motion out of a nested bound group", () => {
    const locals = composeGroupLocalMatrices(
      [parentGroup, childGroup],
      { parent: identity, child: parentRest },
      { parent: quarterTurn, child: quarterTurn },
      { parent: identity, child: identity },
    );
    locals.child.forEach((value, index) => expect(value).toBeCloseTo(identity[index], 9));
  });

  it("keeps a direct child edit local while inheriting its parent once", () => {
    const direct: Matrix = [1, 0, 0, 1, 7, -3];
    const locals = composeGroupLocalMatrices(
      [parentGroup, childGroup],
      { parent: identity, child: parentRest },
      { parent: quarterTurn },
      { parent: identity, child: direct },
    );
    locals.child.forEach((value, index) => expect(value).toBeCloseTo(direct[index], 9));
  });

  it("reaches a child's absolute bone target under a moving SVG parent", () => {
    const childTarget: Matrix = [0, -1, 1, 0, 80, 45];
    const locals = composeGroupLocalMatrices(
      [parentGroup, childGroup],
      { parent: identity, child: parentRest },
      { parent: quarterTurn, child: childTarget },
      { parent: identity, child: identity },
    );
    const effective = multiplyMatrix(
      multiplyMatrix(multiplyMatrix(quarterTurn, parentRest), locals.child),
      invertMatrix(parentRest),
    );
    effective.forEach((value, index) => expect(value).toBeCloseTo(childTarget[index], 9));
  });
});
