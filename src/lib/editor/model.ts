export type GroupTransform = {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  pivotX: number;
  pivotY: number;
};

export type SvgGroup = {
  key: string;
  label: string;
  sourceId: string | null;
  parentKey: string | null;
  depth: number;
};

export type SvgShape = {
  key: string;
  groupKey: string;
  sourceId: string | null;
  tagName: string;
  geometrySignature: string;
  presentationSignature: string;
  ordinalInGroup: number;
};

export type Bone = {
  id: string;
  name: string;
  parentId: string | null;
  groupKey: string | null;
  x: number;
  y: number;
  length: number;
  restRotation: number;
};

export type PixelResizeMode = "contain" | "stretch";

export type BonePoseTransform = {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
};

export type NodeMode = "sharp" | "smooth" | "smart";

export type Pose = {
  id: string;
  name: string;
  transforms: Record<string, GroupTransform>;
  boneTransforms: Record<string, BonePoseTransform>;
  visibility: Record<string, boolean>;
  /** Pose-local path replacements keyed by a generated studio shape id. */
  shapePaths: Record<string, string>;
  /** Affinity-style behavior for editable anchors, keyed by shape then command index. */
  shapeNodeModes: Record<string, Record<string, NodeMode>>;
};

export const identityTransform = (): GroupTransform => ({
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  pivotX: 0,
  pivotY: 0,
});

export const identityBoneTransform = (): BonePoseTransform => ({
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
});

export function composeBoneTransform(setup: BonePoseTransform, pose: BonePoseTransform): BonePoseTransform {
  return {
    x: setup.x + pose.x,
    y: setup.y + pose.y,
    rotation: setup.rotation + pose.rotation,
    scaleX: setup.scaleX * pose.scaleX,
    scaleY: setup.scaleY * pose.scaleY,
  };
}

export function relativeBoneTransform(effective: BonePoseTransform, setup: BonePoseTransform): BonePoseTransform {
  return {
    x: effective.x - setup.x,
    y: effective.y - setup.y,
    rotation: effective.rotation - setup.rotation,
    scaleX: effective.scaleX / Math.max(0.02, setup.scaleX),
    scaleY: effective.scaleY / Math.max(0.02, setup.scaleY),
  };
}

export function cloneTransform(transform: GroupTransform): GroupTransform {
  return { ...transform };
}

export function cloneTransforms(
  transforms: Record<string, GroupTransform>,
): Record<string, GroupTransform> {
  return Object.fromEntries(
    Object.entries(transforms).map(([key, value]) => [key, cloneTransform(value)]),
  );
}

export function createPose(
  name: string,
  transforms: Record<string, GroupTransform> = {},
  boneTransforms: Record<string, BonePoseTransform> = {},
  visibility: Record<string, boolean> = {},
  shapePaths: Record<string, string> = {},
  shapeNodeModes: Record<string, Record<string, NodeMode>> = {},
): Pose {
  return {
    id: crypto.randomUUID(),
    name,
    transforms: cloneTransforms(transforms),
    boneTransforms: Object.fromEntries(
      Object.entries(boneTransforms).map(([key, value]) => [key, { ...value }]),
    ),
    visibility: { ...visibility },
    shapePaths: { ...shapePaths },
    shapeNodeModes: Object.fromEntries(
      Object.entries(shapeNodeModes).map(([shapeKey, modes]) => [shapeKey, { ...modes }]),
    ),
  };
}
