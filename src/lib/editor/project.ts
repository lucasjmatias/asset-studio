import type {
  Bone,
  BonePoseTransform,
  PixelResizeMode,
  Pose,
} from "./model";
import { cloneSerializable } from "./history";

export const ASTD_FORMAT = "asset-studio-project";
export const ASTD_VERSION = 1;

export type AstdProjectState = {
  sourceSvg: string;
  sourceFileName: string;
  poses: Pose[];
  bones: Bone[];
  setupBoneTransforms: Record<string, BonePoseTransform>;
  activePoseId: string;
  selectedGroupKey: string | null;
  selectedBoneId: string | null;
  outputWidth: number;
  outputHeight: number;
  antiAlias: number;
  resizeMode: PixelResizeMode;
  aiPixelFilter: boolean;
  aiPaletteSize: number;
  pixelContourStrength: number;
  pixelDetailFloor: number;
  pixelCoverageThreshold: number;
  preferredRigEditMode: "setup" | "pose";
  primaryView: "vector" | "rig" | null;
  pixelVisible: boolean;
  playbackFps: number;
  onionSkin: boolean;
  onionSkinScope: "all" | "selected";
  onionSkinRadius: number;
  zoom: number;
};

export type AstdProject = {
  format: typeof ASTD_FORMAT;
  version: typeof ASTD_VERSION;
  savedAt: string;
  state: AstdProjectState;
};

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function encodeAstdProject(state: AstdProjectState): string {
  const project: AstdProject = {
    format: ASTD_FORMAT,
    version: ASTD_VERSION,
    savedAt: new Date().toISOString(),
    state: cloneSerializable(state),
  };
  return `${JSON.stringify(project, null, 2)}\n`;
}

export function decodeAstdProject(contents: string): AstdProject {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("This .astd file is not valid JSON.");
  }
  if (!value || typeof value !== "object") throw new Error("This .astd file is empty or invalid.");
  const candidate = value as Partial<AstdProject>;
  if (candidate.format !== ASTD_FORMAT) throw new Error("This file is not an Asset Studio project.");
  if (candidate.version !== ASTD_VERSION) throw new Error(`Unsupported .astd project version: ${String(candidate.version)}.`);
  if (!candidate.state || typeof candidate.state !== "object") throw new Error("The .astd project has no editor state.");

  const raw = candidate.state as Partial<AstdProjectState>;
  if (typeof raw.sourceSvg !== "string" || !raw.sourceSvg.trim()) throw new Error("The .astd project has no source SVG.");
  const poses = Array.isArray(raw.poses) ? raw.poses.map((pose) => ({
    ...pose,
    transforms: pose.transforms ?? {},
    boneTransforms: pose.boneTransforms ?? {},
    visibility: pose.visibility ?? {},
    shapePaths: pose.shapePaths ?? {},
    shapeNodeModes: pose.shapeNodeModes ?? {},
  })) : [];
  const state: AstdProjectState = {
    sourceSvg: raw.sourceSvg,
    sourceFileName: typeof raw.sourceFileName === "string" && raw.sourceFileName ? raw.sourceFileName : "artwork.svg",
    poses,
    bones: Array.isArray(raw.bones) ? raw.bones : [],
    setupBoneTransforms: raw.setupBoneTransforms && typeof raw.setupBoneTransforms === "object" ? raw.setupBoneTransforms : {},
    activePoseId: typeof raw.activePoseId === "string" ? raw.activePoseId : "rest",
    selectedGroupKey: typeof raw.selectedGroupKey === "string" ? raw.selectedGroupKey : null,
    selectedBoneId: typeof raw.selectedBoneId === "string" ? raw.selectedBoneId : null,
    outputWidth: Math.max(1, Math.round(finiteNumber(raw.outputWidth, 64))),
    outputHeight: Math.max(1, Math.round(finiteNumber(raw.outputHeight, 64))),
    antiAlias: Math.max(0, Math.min(100, finiteNumber(raw.antiAlias, 0))),
    resizeMode: raw.resizeMode === "stretch" ? "stretch" : "contain",
    aiPixelFilter: raw.aiPixelFilter === true,
    aiPaletteSize: Math.max(2, Math.min(64, Math.round(finiteNumber(raw.aiPaletteSize, 16)))),
    pixelContourStrength: Math.max(0, Math.min(100, Math.round(finiteNumber(raw.pixelContourStrength, 60)))),
    pixelDetailFloor: Math.max(1, Math.min(4, Math.round(finiteNumber(raw.pixelDetailFloor, 2)))),
    pixelCoverageThreshold: Math.max(10, Math.min(90, Math.round(finiteNumber(raw.pixelCoverageThreshold, 55)))),
    preferredRigEditMode: raw.preferredRigEditMode === "pose" ? "pose" : "setup",
    primaryView: raw.primaryView === "rig" || raw.primaryView === null ? raw.primaryView : "vector",
    pixelVisible: raw.pixelVisible === true,
    playbackFps: [1, 2, 4, 8, 12].includes(finiteNumber(raw.playbackFps, 2)) ? finiteNumber(raw.playbackFps, 2) : 2,
    onionSkin: raw.onionSkin === true,
    onionSkinScope: raw.onionSkinScope === "selected" ? "selected" : "all",
    onionSkinRadius: Math.max(1, Math.min(8, Math.round(finiteNumber(raw.onionSkinRadius, 1)))),
    zoom: Math.max(0.25, Math.min(4, finiteNumber(raw.zoom, 1))),
  };
  return {
    format: ASTD_FORMAT,
    version: ASTD_VERSION,
    savedAt: typeof candidate.savedAt === "string" ? candidate.savedAt : "",
    state: cloneSerializable(state),
  };
}
