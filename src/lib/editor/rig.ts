import { identityBoneTransform, type Bone, type BonePoseTransform, type SvgGroup } from "./model";

export type Matrix = [number, number, number, number, number, number];

export type BoneWorld = {
  matrix: Matrix;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  angle: number;
};

export type BoneEndpoints = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
};

export type GroupFitBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  localToRoot: Matrix;
};

export type RigGroupTarget = {
  key: string;
  centerX: number;
  centerY: number;
  diameter: number;
  order: number;
};

export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

export function dominantSampleOwner(
  owners: Array<string | null>,
  minimumCoverage = 0.6,
): { key: string; coverage: number } | null {
  if (owners.length === 0) return null;
  const counts = new Map<string, number>();
  for (const owner of owners) {
    if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  let winner: { key: string; count: number } | null = null;
  for (const [key, count] of counts) {
    if (!winner || count > winner.count) winner = { key, count };
  }
  if (!winner) return null;
  const coverage = winner.count / owners.length;
  return coverage >= minimumCoverage ? { key: winner.key, coverage } : null;
}

/**
 * Continues a child chain into the nearest unrigged group once the current
 * bone already covers at least half of its group's visual diameter.
 */
export function childBoneTargetGroup(
  currentGroupKey: string | null,
  parent: BoneEndpoints,
  targets: RigGroupTarget[],
  occupiedGroupKeys: Set<string>,
  coverageThreshold = 0.5,
): string | null {
  if (!currentGroupKey) return null;
  const current = targets.find((target) => target.key === currentGroupKey);
  if (!current || current.diameter <= 1e-6) return currentGroupKey;
  const boneLength = Math.hypot(parent.endX - parent.startX, parent.endY - parent.startY);
  if (boneLength < current.diameter * coverageThreshold) return currentGroupKey;

  const available = targets
    .filter((target) => target.key !== currentGroupKey && !occupiedGroupKeys.has(target.key))
    .map((target) => ({
      target,
      edgeDistance: Math.max(0, Math.hypot(target.centerX - parent.endX, target.centerY - parent.endY) - target.diameter / 2),
    }))
    .sort((left, right) => left.edgeDistance - right.edgeDistance || left.target.order - right.target.order);
  return available[0]?.target.key ?? currentGroupKey;
}

export function translateBoneEndpoints(
  endpoints: BoneEndpoints,
  delta: { x: number; y: number },
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  return {
    start: { x: endpoints.startX + delta.x, y: endpoints.startY + delta.y },
    end: { x: endpoints.endX + delta.x, y: endpoints.endY + delta.y },
  };
}

/** Ensures the large/start joint is the endpoint nearest a parent tip. */
export function orientBoneStartToward(
  endpoints: BoneEndpoints,
  target: { x: number; y: number },
): BoneEndpoints {
  const startDistance = Math.hypot(endpoints.startX - target.x, endpoints.startY - target.y);
  const endDistance = Math.hypot(endpoints.endX - target.x, endpoints.endY - target.y);
  return startDistance <= endDistance ? endpoints : {
    startX: endpoints.endX,
    startY: endpoints.endY,
    endX: endpoints.startX,
    endY: endpoints.startY,
  };
}

/**
 * Fit a bone through the centre of a group while preserving its authored
 * direction when supplied. Padding is an inset, keeping both joints inside
 * the shape instead of extending the guide beyond the artwork.
 */
export function fitBoneToGroupBounds(
  bounds: GroupFitBounds,
  paddingRatio = 0.08,
  minimumPadding = 2,
  preferredDirection?: { x: number; y: number },
): BoneEndpoints | null {
  const centre = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const worldCentre = {
    x: bounds.localToRoot[0] * centre.x + bounds.localToRoot[2] * centre.y + bounds.localToRoot[4],
    y: bounds.localToRoot[1] * centre.x + bounds.localToRoot[3] * centre.y + bounds.localToRoot[5],
  };
  const horizontal = {
    x: bounds.localToRoot[0] * bounds.width,
    y: bounds.localToRoot[1] * bounds.width,
  };
  const vertical = {
    x: bounds.localToRoot[2] * bounds.height,
    y: bounds.localToRoot[3] * bounds.height,
  };
  const horizontalLength = Math.hypot(horizontal.x, horizontal.y);
  const verticalLength = Math.hypot(vertical.x, vertical.y);
  const axisLength = Math.max(horizontalLength, verticalLength);
  if (!Number.isFinite(axisLength) || axisLength < 1e-6) return null;

  const preferredLength = preferredDirection ? Math.hypot(preferredDirection.x, preferredDirection.y) : 0;
  const fallbackAxis = horizontalLength >= verticalLength ? horizontal : vertical;
  const unit = preferredDirection && preferredLength > 1e-6
    ? { x: preferredDirection.x / preferredLength, y: preferredDirection.y / preferredLength }
    : { x: fallbackAxis.x / axisLength, y: fallbackAxis.y / axisLength };
  const padding = Math.min(
    axisLength * 0.4,
    Math.max(Math.max(0, minimumPadding), axisLength * Math.max(0, paddingRatio)),
  );
  const halfLength = Math.max(axisLength * 0.1, axisLength / 2 - padding);
  return {
    startX: worldCentre.x - unit.x * halfLength,
    startY: worldCentre.y - unit.y * halfLength,
    endX: worldCentre.x + unit.x * halfLength,
    endY: worldCentre.y + unit.y * halfLength,
  };
}

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

/** Decomposes a bone-local affine matrix into the transform model used by the editor. */
export function boneTransformFromLocalMatrix(bone: Bone, matrix: Matrix): BonePoseTransform {
  const scaleX = Math.max(0.02, Math.hypot(matrix[0], matrix[1]));
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  return {
    x: matrix[4] - bone.x,
    y: matrix[5] - bone.y,
    rotation: Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI - bone.restRotation,
    scaleX,
    scaleY: Math.max(0.02, Math.abs(determinant) / scaleX),
  };
}

/**
 * Moves a child joint with its newly scaled parent while preserving the
 * child's previous world-space angle and size.
 */
export function childWorldMatrixWithoutInheritedScale(
  startParent: Matrix,
  nextParent: Matrix,
  startChild: Matrix,
): Matrix {
  const childInStartParent = multiplyMatrix(invertMatrix(startParent), startChild);
  const nextAnchorX = nextParent[0] * childInStartParent[4] + nextParent[2] * childInStartParent[5] + nextParent[4];
  const nextAnchorY = nextParent[1] * childInStartParent[4] + nextParent[3] * childInStartParent[5] + nextParent[5];
  return [startChild[0], startChild[1], startChild[2], startChild[3], nextAnchorX, nextAnchorY];
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

/**
 * Convert absolute root-space rig deltas into wrapper-local matrices without
 * applying an ancestor group's motion twice. Unbound descendants inherit the
 * nearest parent target; a group with its own bone uses that bone's absolute
 * root-space target and factors the SVG-parent target back out.
 */
export function composeGroupLocalMatrices(
  groups: SvgGroup[],
  parentToRoot: Record<string, Matrix>,
  rigRootMatrices: Record<string, Matrix>,
  directLocalMatrices: Record<string, Matrix>,
): Record<string, Matrix> {
  const targets: Record<string, Matrix> = {};
  const locals: Record<string, Matrix> = {};
  for (const group of [...groups].sort((left, right) => left.depth - right.depth)) {
    const parentTarget = group.parentKey ? targets[group.parentKey] ?? IDENTITY_MATRIX : IDENTITY_MATRIX;
    const parentRest = parentToRoot[group.key] ?? IDENTITY_MATRIX;
    const directLocal = directLocalMatrices[group.key] ?? IDENTITY_MATRIX;
    const directRoot = multiplyMatrix(multiplyMatrix(parentRest, directLocal), invertMatrix(parentRest));
    const rigRoot = rigRootMatrices[group.key];
    const target = rigRoot
      ? multiplyMatrix(rigRoot, directRoot)
      : multiplyMatrix(parentTarget, directRoot);
    targets[group.key] = target;
    locals[group.key] = multiplyMatrix(
      multiplyMatrix(multiplyMatrix(invertMatrix(parentRest), invertMatrix(parentTarget)), target),
      parentRest,
    );
  }
  return locals;
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
