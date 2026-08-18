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

export type Pose = {
  id: string;
  name: string;
  transforms: Record<string, GroupTransform>;
  boneTransforms: Record<string, BonePoseTransform>;
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
): Pose {
  return {
    id: crypto.randomUUID(),
    name,
    transforms: cloneTransforms(transforms),
    boneTransforms: Object.fromEntries(
      Object.entries(boneTransforms).map(([key, value]) => [key, { ...value }]),
    ),
  };
}
