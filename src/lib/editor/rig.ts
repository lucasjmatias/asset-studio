import { identityBoneTransform, type Bone, type BonePoseTransform } from "./model";

export type Matrix = [number, number, number, number, number, number];

export type BoneWorld = {
  matrix: Matrix;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  angle: number;
};

export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

export function multiplyMatrix(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

export function invertMatrix(matrix: Matrix): Matrix {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (Math.abs(determinant) < 1e-10) return IDENTITY_MATRIX;
  return [
    matrix[3] / determinant,
    -matrix[1] / determinant,
    -matrix[2] / determinant,
    matrix[0] / determinant,
    (matrix[2] * matrix[5] - matrix[3] * matrix[4]) / determinant,
    (matrix[1] * matrix[4] - matrix[0] * matrix[5]) / determinant,
  ];
}

/**
 * Express a transform authored in the SVG root coordinate system in the
 * coordinate system of a wrapper's parent. This keeps a root-space pivot
 * (for example, the fixed end of a bone) fixed even when the source group is
 * nested below translated, rotated, or scaled SVG groups.
 */
export function matrixInParentSpace(rootTransform: Matrix, parentToRoot: Matrix): Matrix {
  return multiplyMatrix(multiplyMatrix(invertMatrix(parentToRoot), rootTransform), parentToRoot);
}

function localMatrix(x: number, y: number, degrees: number): Matrix {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [cosine, sine, -sine, cosine, x, y];
}

function scaleMatrix(scaleX: number, scaleY: number): Matrix {
  return [scaleX, 0, 0, scaleY, 0, 0];
}

export function boneWorldMap(
  bones: Bone[],
  transforms: Record<string, BonePoseTransform> = {},
): Record<string, BoneWorld> {
  const byId = new Map(bones.map((bone) => [bone.id, bone]));
  const result: Record<string, BoneWorld> = {};
  const visiting = new Set<string>();

  const resolve = (bone: Bone): BoneWorld => {
    if (result[bone.id]) return result[bone.id];
    if (visiting.has(bone.id)) {
      const pose = transforms[bone.id] ?? identityBoneTransform();
      const matrix = multiplyMatrix(
        localMatrix(bone.x + pose.x, bone.y + pose.y, bone.restRotation + pose.rotation),
        scaleMatrix(pose.scaleX, pose.scaleY),
      );
      return { matrix, startX: matrix[4], startY: matrix[5], endX: matrix[4] + matrix[0] * bone.length, endY: matrix[5] + matrix[1] * bone.length, angle: Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI };
    }
    visiting.add(bone.id);
    const parent = bone.parentId ? byId.get(bone.parentId) : null;
    const parentMatrix = parent ? resolve(parent).matrix : IDENTITY_MATRIX;
    const pose = transforms[bone.id] ?? identityBoneTransform();
    const local = multiplyMatrix(
      localMatrix(bone.x + pose.x, bone.y + pose.y, bone.restRotation + pose.rotation),
      scaleMatrix(pose.scaleX, pose.scaleY),
    );
    const matrix = multiplyMatrix(parentMatrix, local);
    visiting.delete(bone.id);
    const world = {
      matrix,
      startX: matrix[4],
      startY: matrix[5],
      endX: matrix[4] + matrix[0] * bone.length,
      endY: matrix[5] + matrix[1] * bone.length,
      angle: Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI,
    };
    result[bone.id] = world;
    return world;
  };

  for (const bone of bones) resolve(bone);
  return result;
}

export function boneGroupMatrices(
  bones: Bone[],
  transforms: Record<string, BonePoseTransform> = {},
  restTransforms: Record<string, BonePoseTransform> = {},
): Record<string, Matrix> {
  const rest = boneWorldMap(bones, restTransforms);
  const posed = boneWorldMap(bones, transforms);
  const matrices: Record<string, Matrix> = {};
  for (const bone of bones) {
    if (!bone.groupKey) continue;
    matrices[bone.groupKey] = multiplyMatrix(posed[bone.id].matrix, invertMatrix(rest[bone.id].matrix));
  }
  return matrices;
}

export function boneDepth(bone: Bone, bones: Bone[]): number {
  const byId = new Map(bones.map((item) => [item.id, item]));
  const visited = new Set<string>();
  let depth = 0;
  let cursor = bone.parentId ? byId.get(bone.parentId) : null;
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    depth += 1;
    cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
  }
  return depth;
}

export function wouldCreateCycle(boneId: string, candidateParentId: string | null, bones: Bone[]): boolean {
  if (!candidateParentId) return false;
  const byId = new Map(bones.map((bone) => [bone.id, bone]));
  let cursor: Bone | undefined = byId.get(candidateParentId);
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    if (cursor.id === boneId) return true;
    visited.add(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return false;
}
