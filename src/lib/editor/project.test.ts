import { describe, expect, it } from "vitest";

import { createPose } from "./model";
import { ASTD_FORMAT, ASTD_VERSION, decodeAstdProject, encodeAstdProject, type AstdProjectState } from "./project";

function fixture(): AstdProjectState {
  const pose = createPose("Mouth open", {}, {}, { mouthClosed: false, mouthOpen: true });
  return {
    sourceSvg: '<svg viewBox="0 0 8 8"><g id="mouth"/></svg>',
    sourceFileName: "face.svg",
    poses: [pose],
    bones: [{ id: "jaw", name: "Jaw", parentId: null, groupKey: "group-0", x: 2, y: 3, length: 4, restRotation: 10 }],
    setupBoneTransforms: { jaw: { x: 1, y: 0, rotation: 5, scaleX: 1, scaleY: 1 } },
    activePoseId: pose.id,
    selectedGroupKey: "group-0",
    selectedBoneId: "jaw",
    outputWidth: 32,
    outputHeight: 24,
    antiAlias: 0,
    resizeMode: "contain",
    aiPixelFilter: true,
    aiPaletteSize: 12,
    preferredRigEditMode: "pose",
    primaryView: "rig",
    pixelVisible: true,
    playbackFps: 4,
    zoom: 1.2,
  };
}

describe(".astd projects", () => {
  it("round-trips source, poses, bones, visibility, and editor settings", () => {
    const state = fixture();
    const decoded = decodeAstdProject(encodeAstdProject(state));
    expect(decoded.format).toBe(ASTD_FORMAT);
    expect(decoded.version).toBe(ASTD_VERSION);
    expect(decoded.state).toEqual(state);
  });

  it("rejects unrelated JSON", () => {
    expect(() => decodeAstdProject('{"version":1}')).toThrow(/not an Asset Studio project/i);
  });
});
