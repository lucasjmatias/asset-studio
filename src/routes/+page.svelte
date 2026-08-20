<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { open, save } from "@tauri-apps/plugin-dialog";
  import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
  import initStudioCore, { transform_matrix } from "$lib/wasm/studio_core.js";
  import { composeBoneTransform, createPose, identityBoneTransform, identityTransform, relativeBoneTransform, type Bone, type BonePoseTransform, type GroupTransform, type NodeMode, type PixelResizeMode, type Pose, type SvgGroup, type SvgShape } from "$lib/editor/model";
  import { applyShapePath, applyShapePaths, highlightBoneWrapper, prepareSvg, selectWrapper, serializeForExport, setWrapperMatrix, setWrapperVisibility, shapeElementToPathData } from "$lib/editor/svg";
  import { encodedPngToCanvas, loadCanvasKit, overlayOnionSkins, rasterizeSvg, renderEncodedPixelPreview, renderPixelPreview } from "$lib/editor/pixel-preview";
  import { boneDepth, boneGroupMatrices, boneTransformFromLocalMatrix, boneWorldMap, childBoneTargetGroup, childWorldMatrixWithoutInheritedScale, composeGroupLocalMatrices, fitBoneToGroupBounds, invertMatrix, multiplyMatrix, orientBoneStartToward, translateBoneEndpoints, wouldCreateCycle, type Matrix, type RigGroupTarget } from "$lib/editor/rig";
  import { appendHistory, cloneSerializable, snapshotsEqual, type HistoryEntry } from "$lib/editor/history";
  import { decodeAstdProject, encodeAstdProject, type AstdProjectState } from "$lib/editor/project";
  import { remapGroupRecord, remapShapeRecord, replacementGroupMap, replacementShapeMap } from "$lib/editor/relink";
  import { clampCanvasZoom, outputPixelDelta, zoomPanAroundAnchor } from "$lib/editor/viewport";
  import { addPathNodeAfter, configurePathNode, deformPathWithBones, movePathHandle, nodeIndexForHandle, parsePathData, pathArea, pathControlGuides, pathHandles, removePathNode, serializePathData, type ControlGuide, type PathBoneInfluence, type PathCommand, type PathHandle } from "$lib/editor/shape";
  import { steppedPoseId, wrappedPoseNeighbors } from "$lib/editor/animation";
  import "./studio.css";

  type EditorTool = "move" | "rotate" | "scale" | "shape";
  type ModalTransformTool = Exclude<EditorTool, "shape">;
  type RigEditMode = "setup" | "pose";
  type BoneGesture = "move" | "rotate-start" | "rotate-end" | "scale-start" | "scale-end";
  type PrimaryView = "vector" | "rig";
  type Session = { sourceSvg: string; fileName: string; poses: Pose[]; bones: Bone[]; activePoseId: string; outputWidth: number; outputHeight: number; antiAlias: number; resizeMode: PixelResizeMode; rigEditMode?: RigEditMode; preferredRigEditMode?: RigEditMode; aiPixelFilter?: boolean; aiPaletteSize?: number; pixelContourStrength?: number; pixelDetailFloor?: number; pixelCoverageThreshold?: number; primaryView?: PrimaryView | null; pixelVisible?: boolean; playbackFps?: number; onionSkin?: boolean; onionSkinScope?: "all" | "selected"; onionSkinRadius?: number; setupBoneTransforms?: Record<string, BonePoseTransform>; rigTransformModel?: number; zoom?: number; canvasPan?: { x: number; y: number } };
  type DocumentSnapshot = { poses: Pose[]; bones: Bone[]; setupBoneTransforms: Record<string, BonePoseTransform>; activePoseId: string; selectedGroupKey: string | null; selectedBoneId: string | null };
  type DragState = { pointerId: number; key: string; startPoint: { x: number; y: number }; startTransform: GroupTransform; inverse: DOMMatrix; rootToTool: Matrix; pivot: { x: number; y: number }; startAngle: number; startDistance: number; startDx: number; startDy: number; historyBefore: DocumentSnapshot };
  type BoneDragState = { pointerId: number; boneId: string; gesture: BoneGesture; inverse: DOMMatrix; startPoint: DOMPoint; startBone: Bone; startSetup: BonePoseTransform; startPose: BonePoseTransform; startEffective: BonePoseTransform; parentInverse: Matrix; startMatrix: Matrix; startWorld: { startX: number; startY: number; endX: number; endY: number }; startChildMatrices: Record<string, Matrix>; historyBefore: DocumentSnapshot };
  type PanDragState = { pointerId: number; startClient: { x: number; y: number }; startPan: { x: number; y: number } };
  type SelectionOverlay = { key: string; x: number; y: number; width: number; height: number; matrix: string; kind: "selection" | "bone" };
  type ShapeEditor = { shapeKey: string; groupKey: string; d: string; sourceD: string; commands: PathCommand[]; handles: PathHandle[]; guides: ControlGuide[]; matrix: string; rootToLocal: Matrix; sourceArea: number; currentArea: number };
  type ShapeDragState = { pointerId: number; handle: PathHandle; nodeMode: NodeMode; historyBefore: DocumentSnapshot };

  const cursorSvg = (body: string, fallback: string, angle = 0) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g transform="rotate(${angle} 16 16)" fill="none" stroke="#f4c96d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="#101416" stroke-width="4" d="${body}"/><path d="${body}"/></g></svg>`)}") 16 16, ${fallback}`;
  const moveCursor = cursorSvg("M16 3l-4 4m4-4l4 4M16 29l-4-4m4 4l4-4M3 16l4-4m-4 4l4 4M29 16l-4-4m4 4l-4 4M16 4v24M4 16h24", "move");
  const rotateCursor = cursorSvg("M8 11a10 10 0 0 1 16-3l2 3m-2-3l-3 2M24 21a10 10 0 0 1-16 3l-2-3m2 3l3-2", "alias");
  function resizeCursor(angle: number) {
    return cursorSvg("M16 4l-4 4m4-4l4 4M16 28l-4-4m4 4l4-4M16 5v22", "ew-resize", Math.round(angle + 90));
  }

  let svgHost: HTMLDivElement;
  let previewCanvas: HTMLCanvasElement;
  let primaryViewport: HTMLDivElement;
  let rigSvg = $state<SVGSVGElement>();
  let vectorOverlay = $state<SVGSVGElement>();
  let fileInput: HTMLInputElement;
  let projectFileInput: HTMLInputElement;
  let sourceSvg = $state("");
  let fileName = $state("No source loaded");
  let groups = $state<SvgGroup[]>([]);
  let shapes = $state<SvgShape[]>([]);
  let poses = $state<Pose[]>([]);
  let bones = $state<Bone[]>([]);
  let setupBoneTransforms = $state<Record<string, BonePoseTransform>>({});
  let activePoseId = $state("rest");
  let selectedGroupKey = $state<string | null>(null);
  let selectedBoneId = $state<string | null>(null);
  let selectedShapeKey = $state<string | null>(null);
  let selectedShapeNodeIndex = $state<number | null>(null);
  let outputWidth = $state(64);
  let outputHeight = $state(64);
  let antiAlias = $state(0);
  let resizeMode = $state<PixelResizeMode>("contain");
  let aiPixelFilter = $state(false);
  let aiPaletteSize = $state(16);
  let pixelContourStrength = $state(60);
  let pixelDetailFloor = $state(2);
  let pixelCoverageThreshold = $state(55);
  let activeTool = $state<EditorTool>("move");
  let modalTool = $state<ModalTransformTool | null>(null);
  let modalReturnTool: EditorTool = "move";
  let svgImportMode: "new" | "replace" = "new";
  let lockRatio = $state(true);
  let preserveArea = $state(false);
  let rigEditMode = $state<RigEditMode>("setup");
  let preferredRigEditMode = $state<RigEditMode>("setup");
  let viewMode = $state<PrimaryView | null>("vector");
  let pixelVisible = $state(false);
  let leftMode = $state<"groups" | "rig">("groups");
  let viewBox = $state<[number, number, number, number]>([0, 0, 512, 512]);
  let zoom = $state(1);
  let canvasPan = $state({ x: 0, y: 0 });
  let panDrag = $state<PanDragState | null>(null);
  let status = $state("Ready for an SVG");
  let warnings = $state<string[]>([]);
  let canvasBackend = $state("CanvasKit loading");
  let wasmReady = $state(false);
  let desktopRuntime = $state(false);
  let dirty = $state(false);
  let projectPath = $state<string | null>(null);
  let isPlaying = $state(false);
  let playbackFps = $state(2);
  let onionSkin = $state(false);
  let onionSkinScope = $state<"all" | "selected">("all");
  let onionSkinRadius = $state(1);
  let playbackTimer: ReturnType<typeof setTimeout> | null = null;
  let drag: DragState | null = null;
  let boneDrag = $state<BoneDragState | null>(null);
  let shapeDrag = $state<ShapeDragState | null>(null);
  let selectionOverlay = $state<SelectionOverlay | null>(null);
  let shapeEditor = $state<ShapeEditor | null>(null);
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let previewRunning = false;
  let previewQueued = false;
  let previewRevision = 0;
  let pixelPrerenderGeneration = 0;
  const pixelFrameCache = new Map<string, Uint8Array>();
  let pixelPrerenderPromise: Promise<void> | null = null;
  let aiPreviewBusy = $state(false);
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let overlayFrame: number | null = null;
  let setupFrozenMatrices: Record<string, Matrix> = {};
  let undoStack = $state<HistoryEntry<DocumentSnapshot>[]>([]);
  let redoStack = $state<HistoryEntry<DocumentSnapshot>[]>([]);
  const pivots: Record<string, { x: number; y: number }> = {};
  const worldPivots: Record<string, { x: number; y: number }> = {};
  const wrapperParentMatrices: Record<string, Matrix> = {};
  const shapeToRootMatrices: Record<string, Matrix> = {};

  const activePose = $derived(poses.find((pose) => pose.id === activePoseId) ?? null);
  const selectedGroup = $derived(groups.find((group) => group.key === selectedGroupKey) ?? null);
  const selectedBone = $derived(bones.find((bone) => bone.id === selectedBoneId) ?? null);
  // Setup and Pose share the same visible guide placement. The mode only
  // decides whether the artwork is frozen or follows those guides.
  const boneWorlds = $derived(boneWorldMap(bones, effectiveBoneTransforms(activePose)));
  const renderedBones = $derived([...bones].sort((left, right) => Number(left.id === selectedBoneId) - Number(right.id === selectedBoneId)));
  const canvasTransformMode = $derived(modalTool ?? (viewMode === "vector" && activeTool !== "shape" ? activeTool : null));
  const canvasToolCursor = $derived(
    canvasTransformMode === "move"
      ? moveCursor
      : canvasTransformMode === "rotate"
        ? rotateCursor
        : canvasTransformMode === "scale"
          ? resizeCursor(viewMode === "rig" && selectedBoneId ? boneWorlds[selectedBoneId]?.angle ?? -45 : -45)
          : "default",
  );
  const canEdit = $derived(Boolean(sourceSvg && activePose));
  const frameCount = $derived(poses.length);
  const projectName = $derived(projectPath?.split(/[\\/]/).pop() ?? "UNSAVED .ASTD");
  const shapeVolumePercent = $derived(shapeEditor && shapeEditor.sourceArea > 1e-8 ? shapeEditor.currentArea / shapeEditor.sourceArea * 100 : 100);
  const selectedShapeNodeMode = $derived(shapeEditor && selectedShapeNodeIndex !== null
    ? activePose?.shapeNodeModes?.[shapeEditor.shapeKey]?.[String(selectedShapeNodeIndex)] ?? inferredShapeNodeMode(shapeEditor.commands, selectedShapeNodeIndex)
    : "sharp");

  function inferredShapeNodeMode(commands: PathCommand[], nodeIndex: number): NodeMode {
    const anchor = commands[nodeIndex];
    if (!anchor || anchor.type === "Z") return "sharp";
    const values = anchor.values;
    const x = values.at(-2) ?? 0, y = values.at(-1) ?? 0;
    const incomingVisible = anchor.type === "Q" || (anchor.type === "C" && Math.hypot(values[2] - x, values[3] - y) > 0.001);
    const outgoing = commands[nodeIndex + 1];
    const outgoingVisible = outgoing?.type === "Q" || (outgoing?.type === "C" && Math.hypot(outgoing.values[0] - x, outgoing.values[1] - y) > 0.001);
    return incomingVisible || outgoingVisible ? "smooth" : "sharp";
  }

  onMount(async () => {
    desktopRuntime = isTauri();
    try { await initStudioCore(); wasmReady = true; }
    catch (error) { console.error(error); status = "Rust/WASM core unavailable; using matrix fallback"; }
    loadCanvasKit().then(() => (canvasBackend = "CanvasKit · Skia/WASM")).catch((error) => {
      console.error("CanvasKit initialization failed", error);
      canvasBackend = "Canvas fallback";
    });

    const cached = localStorage.getItem("asset-studio:last-session");
    if (!cached) return;
    try {
      const session = JSON.parse(cached) as Session;
      await loadSvgSource(session.sourceSvg, session.fileName, false);
      const restoredPoses = (session.poses ?? []).map((pose) => {
        const legacy = pose as Pose & { boneRotations?: Record<string, number> };
        const migrated = legacy.boneTransforms ?? Object.fromEntries(
          Object.entries(legacy.boneRotations ?? {}).map(([id, rotation]) => [id, { ...identityBoneTransform(), rotation }]),
        );
        return { ...pose, boneTransforms: migrated, visibility: pose.visibility ?? {}, shapePaths: pose.shapePaths ?? {}, shapeNodeModes: pose.shapeNodeModes ?? {} };
      });
      bones = session.bones ?? [];
      const restoredActivePoseId = restoredPoses.some((pose) => pose.id === session.activePoseId) ? session.activePoseId : "rest";
      if (session.rigTransformModel === 2) {
        setupBoneTransforms = session.setupBoneTransforms ?? {};
        poses = restoredPoses;
      } else {
        const baseline = restoredPoses.find((pose) => pose.id === restoredActivePoseId)?.boneTransforms ?? {};
        setupBoneTransforms = Object.fromEntries(Object.entries(baseline).map(([id, transform]) => [id, { ...transform }]));
        poses = restoredPoses.map((pose) => ({
          ...pose,
          boneTransforms: Object.fromEntries(bones.flatMap((bone) => {
            const relative = relativeBoneTransform(pose.boneTransforms?.[bone.id] ?? identityBoneTransform(), baseline[bone.id] ?? identityBoneTransform());
            const isIdentity = Math.abs(relative.x) < 1e-8 && Math.abs(relative.y) < 1e-8 && Math.abs(relative.rotation) < 1e-8 && Math.abs(relative.scaleX - 1) < 1e-8 && Math.abs(relative.scaleY - 1) < 1e-8;
            return isIdentity ? [] : [[bone.id, relative]];
          })),
        }));
      }
      activePoseId = restoredActivePoseId;
      outputWidth = session.outputWidth || 64;
      outputHeight = session.outputHeight || 64;
      antiAlias = Number.isFinite(session.antiAlias) ? session.antiAlias : 0;
      resizeMode = session.resizeMode === "stretch" ? "stretch" : "contain";
      aiPixelFilter = session.aiPixelFilter === true;
      aiPaletteSize = Math.max(2, Math.min(64, session.aiPaletteSize || 16));
      pixelContourStrength = Math.max(0, Math.min(100, session.pixelContourStrength ?? 60));
      pixelDetailFloor = Math.max(1, Math.min(4, session.pixelDetailFloor ?? 2));
      pixelCoverageThreshold = Math.max(10, Math.min(90, session.pixelCoverageThreshold ?? 55));
      preferredRigEditMode = session.preferredRigEditMode === "pose" || session.rigEditMode === "pose" ? "pose" : "setup";
      rigEditMode = restoredActivePoseId === "rest" ? "setup" : preferredRigEditMode;
      viewMode = session.primaryView === "rig" || session.primaryView === null ? session.primaryView : "vector";
      pixelVisible = session.pixelVisible === true;
      if (!viewMode && !pixelVisible) viewMode = "vector";
      playbackFps = [1, 2, 4, 8, 12].includes(session.playbackFps || 0) ? session.playbackFps! : 2;
      onionSkin = session.onionSkin === true;
      onionSkinScope = session.onionSkinScope === "selected" ? "selected" : "all";
      onionSkinRadius = Math.max(1, Math.min(8, Math.round(session.onionSkinRadius ?? 1)));
      zoom = Math.max(0.25, Math.min(4, session.zoom ?? 1));
      canvasPan = Number.isFinite(session.canvasPan?.x) && Number.isFinite(session.canvasPan?.y)
        ? { x: session.canvasPan!.x, y: session.canvasPan!.y }
        : { x: 0, y: 0 };
      requestAnimationFrame(() => { if (rigEditMode === "setup") setupFrozenMatrices = calculatedGroupMatrices(); applyAllTransforms(); });
      status = `Restored ${session.fileName}`;
      schedulePersist();
    } catch (error) { console.warn("Unable to restore prior session", error); }
  });

  onDestroy(() => {
    previewRevision += 1;
    clearPixelPrerenderCache();
    if (previewTimer) clearTimeout(previewTimer);
    if (persistTimer) clearTimeout(persistTimer);
    if (playbackTimer) clearTimeout(playbackTimer);
    if (overlayFrame !== null) cancelAnimationFrame(overlayFrame);
  });

  function isTauri() { return "__TAURI_INTERNALS__" in window; }
  function captureDocument(): DocumentSnapshot {
    return cloneSerializable({ poses, bones, setupBoneTransforms, activePoseId, selectedGroupKey, selectedBoneId });
  }
  function commitHistory(label: string, before: DocumentSnapshot) {
    const after = captureDocument();
    if (snapshotsEqual(before, after)) return;
    undoStack = appendHistory(undoStack, { label, before, after });
    redoStack = [];
    dirty = true;
  }
  function restoreDocument(snapshot: DocumentSnapshot) {
    const restored = cloneSerializable(snapshot);
    poses = restored.poses;
    bones = restored.bones;
    setupBoneTransforms = restored.setupBoneTransforms;
    activePoseId = poses.some((pose) => pose.id === snapshot.activePoseId) ? snapshot.activePoseId : "rest";
    selectedGroupKey = groups.some((group) => group.key === snapshot.selectedGroupKey) ? snapshot.selectedGroupKey : null;
    selectedBoneId = bones.some((bone) => bone.id === snapshot.selectedBoneId) ? snapshot.selectedBoneId : null;
    rigEditMode = activePoseId === "rest" ? "setup" : preferredRigEditMode;
    if (rigEditMode === "setup") setupFrozenMatrices = calculatedGroupMatrices();
    applyAllTransforms(); dirty = true; schedulePersist();
  }
  function undo() {
    const entry = undoStack.at(-1);
    if (!entry) { status = "Nothing to undo"; return; }
    if (isPlaying) stopPlayback();
    undoStack = undoStack.slice(0, -1);
    redoStack = [...redoStack, entry];
    restoreDocument(entry.before);
    status = `Undo · ${entry.label}`;
  }
  function redo() {
    const entry = redoStack.at(-1);
    if (!entry) { status = "Nothing to redo"; return; }
    if (isPlaying) stopPlayback();
    redoStack = redoStack.slice(0, -1);
    undoStack = [...undoStack, entry];
    restoreDocument(entry.after);
    status = `Redo · ${entry.label}`;
  }
  function currentTransform(key: string): GroupTransform {
    return transformForPose(key, activePose);
  }
  function groupIsVisible(key: string, pose: Pose | null = activePose) {
    return pose?.visibility?.[key] !== false;
  }
  function transformForPose(key: string, pose: Pose | null): GroupTransform {
    const pivot = pivots[key] ?? { x: 0, y: 0 };
    return pose?.transforms[key] ?? { ...identityTransform(), pivotX: pivot.x, pivotY: pivot.y };
  }
  function matrixFor(transform: GroupTransform): number[] {
    if (wasmReady) return Array.from(transform_matrix(transform.x, transform.y, transform.rotation, transform.scaleX, transform.scaleY, transform.pivotX, transform.pivotY));
    const radians = transform.rotation * Math.PI / 180;
    const cosine = Math.cos(radians), sine = Math.sin(radians);
    const a = cosine * transform.scaleX, b = sine * transform.scaleX, c = -sine * transform.scaleY, d = cosine * transform.scaleY;
    return [a, b, c, d, transform.x + transform.pivotX - a * transform.pivotX - c * transform.pivotY, transform.y + transform.pivotY - b * transform.pivotX - d * transform.pivotY];
  }
  function multiBoneGroupKeys(): Set<string> {
    const counts = new Map<string, number>();
    for (const bone of bones) if (bone.groupKey) counts.set(bone.groupKey, (counts.get(bone.groupKey) ?? 0) + 1);
    return new Set(Array.from(counts.entries()).filter(([, count]) => count > 1).map(([key]) => key));
  }
  function calculatedGroupMatricesFor(pose: Pose | null): Record<string, Matrix> {
    const rigMatrices = boneGroupMatrices(bones, effectiveBoneTransforms(pose), setupBoneTransforms);
    for (const key of multiBoneGroupKeys()) delete rigMatrices[key];
    const directMatrices = Object.fromEntries(groups.map((group) => [group.key, matrixFor(transformForPose(group.key, pose)) as Matrix]));
    return composeGroupLocalMatrices(groups, wrapperParentMatrices, rigMatrices, directMatrices);
  }
  function calculatedGroupMatrices(): Record<string, Matrix> { return calculatedGroupMatricesFor(activePose); }
  function matrixText(matrix: DOMMatrix): string {
    return `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`;
  }
  function relativeSvgMatrix(element: SVGGraphicsElement, root: SVGSVGElement): DOMMatrix | null {
    const rootMatrix = root.getCTM();
    const elementMatrix = element.getCTM();
    return rootMatrix && elementMatrix ? rootMatrix.inverse().multiply(elementMatrix) : null;
  }
  function editableShapesForGroup(key: string): SVGGraphicsElement[] {
    return Array.from(svgHost.querySelectorAll(`[data-studio-shape-group="${CSS.escape(key)}"][data-studio-shape]`))
      .filter((element): element is SVGGraphicsElement => element instanceof SVGGraphicsElement);
  }
  function refreshEditorOverlay() {
    overlayFrame = null;
    if (!svgHost || !sourceSvg || !viewMode) { selectionOverlay = null; shapeEditor = null; return; }
    const root = svgHost.querySelector("svg") as SVGSVGElement | null;
    if (!root) { selectionOverlay = null; shapeEditor = null; return; }
    const overlayKey = viewMode === "rig" ? selectedBone?.groupKey ?? null : selectedGroupKey;
    if (overlayKey) {
      const wrapper = svgHost.querySelector(`[data-studio-group="${CSS.escape(overlayKey)}"]`) as SVGGElement | null;
      const relative = wrapper ? relativeSvgMatrix(wrapper, root) : null;
      if (wrapper && relative) {
        try {
          const box = wrapper.getBBox();
          selectionOverlay = { key: overlayKey, x: box.x, y: box.y, width: box.width, height: box.height, matrix: matrixText(relative), kind: viewMode === "rig" ? "bone" : "selection" };
        } catch { selectionOverlay = null; }
      } else selectionOverlay = null;
    } else selectionOverlay = null;

    if (viewMode !== "vector" || activeTool !== "shape" || !selectedGroupKey || shapeDrag) {
      if (!shapeDrag) shapeEditor = null;
      return;
    }
    const candidates = editableShapesForGroup(selectedGroupKey);
    const requested = selectedShapeKey ? candidates.find((element) => element.dataset.studioShape === selectedShapeKey) : null;
    const target = requested ?? candidates.sort((left, right) => {
      try {
        const leftGeometry = (svgHost.querySelector(`[data-studio-shape-render="${CSS.escape(left.dataset.studioShape || "")}"]`) as SVGGraphicsElement | null) ?? left;
        const rightGeometry = (svgHost.querySelector(`[data-studio-shape-render="${CSS.escape(right.dataset.studioShape || "")}"]`) as SVGGraphicsElement | null) ?? right;
        const a = leftGeometry.getBBox(), b = rightGeometry.getBBox();
        return b.width * b.height - a.width * a.height;
      }
      catch { return 0; }
    })[0];
    const key = target?.dataset.studioShape;
    if (!target || !key) { shapeEditor = null; return; }
    const sourceD = shapeElementToPathData(target);
    const geometry = (svgHost.querySelector(`[data-studio-shape-render="${CSS.escape(key)}"]`) as SVGGraphicsElement | null) ?? target;
    const relative = relativeSvgMatrix(geometry, root);
    if (!sourceD || !relative) { shapeEditor = null; return; }
    try {
      const d = activePose?.shapePaths?.[key] ?? sourceD;
      const commands = parsePathData(d);
      selectedShapeKey = key;
      shapeEditor = {
        shapeKey: key,
        groupKey: selectedGroupKey,
        d,
        sourceD,
        commands,
        handles: pathHandles(commands),
        guides: pathControlGuides(commands),
        matrix: matrixText(relative),
        rootToLocal: [relative.inverse().a, relative.inverse().b, relative.inverse().c, relative.inverse().d, relative.inverse().e, relative.inverse().f],
        sourceArea: pathArea(parsePathData(sourceD)),
        currentArea: pathArea(commands),
      };
    } catch (error) {
      console.warn("Unable to expose SVG path nodes", error);
      shapeEditor = null;
    }
  }
  function scheduleEditorOverlay() {
    if (overlayFrame !== null) cancelAnimationFrame(overlayFrame);
    overlayFrame = requestAnimationFrame(refreshEditorOverlay);
  }
  function applyPoseShapePaths(pose: Pose | null, deformFromRig: boolean) {
    applyShapePaths(svgHost, pose?.shapePaths ?? {});
    if (!pose || !deformFromRig) return;

    const restWorlds = boneWorldMap(bones, setupBoneTransforms);
    const posedWorlds = boneWorldMap(bones, effectiveBoneTransforms(pose));
    for (const groupKey of multiBoneGroupKeys()) {
      const groupBones = bones.filter((bone) => bone.groupKey === groupKey);
      const movedBones = groupBones.filter((bone) => {
        const rest = restWorlds[bone.id]?.matrix;
        const posed = posedWorlds[bone.id]?.matrix;
        return rest && posed && posed.some((value, index) => Math.abs(value - rest[index]) > 1e-7);
      });
      if (movedBones.length === 0) continue;

      for (const original of editableShapesForGroup(groupKey)) {
        const shapeKey = original.dataset.studioShape;
        const sourceD = shapeElementToPathData(original);
        const localToRoot = shapeKey ? shapeToRootMatrices[shapeKey] : null;
        if (!shapeKey || !sourceD || !localToRoot) continue;
        const rootToLocal = invertMatrix(localToRoot);
        const influences = groupBones.flatMap((bone): PathBoneInfluence[] => {
          const rest = restWorlds[bone.id];
          const posed = posedWorlds[bone.id];
          if (!rest || !posed) return [];
          const deltaRoot = multiplyMatrix(posed.matrix, invertMatrix(rest.matrix));
          const localDelta = multiplyMatrix(multiplyMatrix(rootToLocal, deltaRoot), localToRoot);
          return [{
            start: pointWithMatrix(rootToLocal, rest.startX, rest.startY),
            end: pointWithMatrix(rootToLocal, rest.endX, rest.endY),
            matrix: localDelta,
          }];
        });
        if (influences.length < 2) continue;
        try {
          const baseCommands = parsePathData(pose.shapePaths?.[shapeKey] ?? sourceD);
          const deformed = deformPathWithBones(baseCommands, influences, true);
          applyShapePath(svgHost, shapeKey, serializePathData(deformed));
        } catch (error) {
          console.warn("Unable to skin SVG path from its pose bones", error);
        }
      }
    }
  }
  function applyAllTransforms() {
    if (!svgHost) return;
    const calculated = calculatedGroupMatrices();
    const freezeRig = viewMode === "rig" && rigEditMode === "setup" && !isPlaying;
    for (const group of groups) {
      setWrapperMatrix(svgHost, group.key, freezeRig && setupFrozenMatrices[group.key] ? setupFrozenMatrices[group.key] : calculated[group.key]);
      setWrapperVisibility(svgHost, group.key, groupIsVisible(group.key));
    }
    applyPoseShapePaths(activePose, rigEditMode === "pose" || isPlaying);
    selectWrapper(svgHost, selectedGroupKey);
    highlightBoneWrapper(svgHost, selectedBone?.groupKey ?? null);
    scheduleEditorOverlay();
    schedulePreview(isPlaying);
  }
  function setRigEditMode(mode: RigEditMode) {
    if (mode === "pose" && !activePose) { status = "Create a pose before entering Pose mode."; return; }
    if (mode === "setup") setupFrozenMatrices = calculatedGroupMatrices();
    preferredRigEditMode = mode; rigEditMode = mode; dirty = true; applyAllTransforms(); schedulePersist();
    status = mode === "setup" ? "Setup: arrange the shared guides while artwork stays frozen" : "Pose: artwork now follows the same guide placement";
  }
  function showRig() {
    if (rigEditMode === "setup") setupFrozenMatrices = calculatedGroupMatrices();
    viewMode = "rig"; leftMode = "rig"; applyAllTransforms();
  }
  function togglePrimaryView(mode: PrimaryView) {
    if (modalTool) exitModalTransform(false);
    if (viewMode === mode && pixelVisible) {
      viewMode = null;
    } else {
      viewMode = mode;
      if (mode === "rig") {
        leftMode = "rig";
        if (rigEditMode === "setup") setupFrozenMatrices = calculatedGroupMatrices();
      }
    }
    applyAllTransforms(); schedulePersist();
  }
  function togglePixelView() {
    pixelVisible = !pixelVisible;
    if (!pixelVisible && !viewMode) viewMode = "vector";
    if (pixelVisible) schedulePreview();
    schedulePersist();
  }
  function setCanvasZoom(value: number, anchor?: { x: number; y: number }) {
    const next = clampCanvasZoom(value);
    if (Math.abs(next - zoom) < 1e-6) return;
    if (anchor && primaryViewport) {
      const rect = primaryViewport.getBoundingClientRect();
      const origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const result = zoomPanAroundAnchor(zoom, next, canvasPan, anchor, origin);
      canvasPan = result.pan;
    }
    zoom = next;
    schedulePersist();
  }
  function canvasWheel(event: WheelEvent) {
    if (!viewMode) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    setCanvasZoom(zoom * factor, { x: event.clientX, y: event.clientY });
    status = `Canvas zoom · ${Math.round(zoom * 100)}%`;
  }
  function viewportPointerDown(event: PointerEvent) {
    if (viewMode && modalTool && event.button === 0 && !(event.target as Element).closest(".artboard-wrap")) {
      if (viewMode === "rig" && selectedBoneId) {
        const gesture: BoneGesture = modalTool === "move" ? "move" : modalTool === "rotate" ? "rotate-end" : "scale-end";
        bonePointerDown(event, selectedBoneId, gesture);
      } else if (viewMode === "vector") {
        pointerDown(event);
      }
      return;
    }
    if (!viewMode || event.button !== 1) return;
    panDrag = {
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startPan: { ...canvasPan },
    };
    primaryViewport.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function viewportPointerMove(event: PointerEvent) {
    if (!panDrag || panDrag.pointerId !== event.pointerId) return;
    canvasPan = {
      x: panDrag.startPan.x + event.clientX - panDrag.startClient.x,
      y: panDrag.startPan.y + event.clientY - panDrag.startClient.y,
    };
    event.preventDefault();
  }
  function viewportPointerUp(event: PointerEvent) {
    if (!panDrag || panDrag.pointerId !== event.pointerId) return;
    panDrag = null;
    schedulePersist();
    status = `Canvas panned · ${Math.round(canvasPan.x)}, ${Math.round(canvasPan.y)}`;
    event.preventDefault();
  }
  function collectPivots() {
    const root = svgHost.querySelector("svg");
    const studioWrappers = Array.from(svgHost.querySelectorAll("[data-studio-group]")) as SVGGElement[];
    const wrapperTransforms = studioWrappers.map((wrapper) => wrapper.getAttribute("transform"));
    // Measure the source coordinate systems, never a pose/setup wrapper. The
    // attributes are restored synchronously before the browser paints.
    for (const wrapper of studioWrappers) wrapper.removeAttribute("transform");
    for (const key of Object.keys(pivots)) delete pivots[key];
    for (const key of Object.keys(worldPivots)) delete worldPivots[key];
    for (const key of Object.keys(wrapperParentMatrices)) delete wrapperParentMatrices[key];
    for (const key of Object.keys(shapeToRootMatrices)) delete shapeToRootMatrices[key];
    const rootCtm = root?.getCTM();
    const rootInverse = rootCtm?.inverse();
    try {
      for (const group of groups) {
        const wrapper = svgHost.querySelector(`[data-studio-group="${CSS.escape(group.key)}"]`) as SVGGElement | null;
        if (!wrapper) continue;
        try {
          const box = wrapper.getBBox();
          const localPivot = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          pivots[group.key] = localPivot;
          const parentCtm = (wrapper.parentElement as SVGGraphicsElement | null)?.getCTM();
          if (rootInverse && parentCtm) {
            const relative = rootInverse.multiply(parentCtm);
            const matrix: Matrix = [relative.a, relative.b, relative.c, relative.d, relative.e, relative.f];
            wrapperParentMatrices[group.key] = matrix;
            worldPivots[group.key] = pointWithMatrix(matrix, localPivot.x, localPivot.y);
          } else {
            wrapperParentMatrices[group.key] = [1, 0, 0, 1, 0, 0];
            worldPivots[group.key] = localPivot;
          }
        } catch {
          pivots[group.key] = { x: 0, y: 0 };
          worldPivots[group.key] = { x: 0, y: 0 };
          wrapperParentMatrices[group.key] = [1, 0, 0, 1, 0, 0];
        }
      }
      if (root && rootInverse) for (const shape of Array.from(svgHost.querySelectorAll("[data-studio-shape]"))) {
        const key = (shape as SVGElement).dataset.studioShape;
        const ctm = (shape as SVGGraphicsElement).getCTM?.();
        if (!key || !ctm) continue;
        const relative = rootInverse.multiply(ctm);
        shapeToRootMatrices[key] = [relative.a, relative.b, relative.c, relative.d, relative.e, relative.f];
      }
    } finally {
      studioWrappers.forEach((wrapper, index) => {
        const transform = wrapperTransforms[index];
        if (transform === null) wrapper.removeAttribute("transform");
        else wrapper.setAttribute("transform", transform);
      });
    }
  }
  async function loadSvgSource(svg: string, name: string, persist = true) {
    const prepared = prepareSvg(svg);
    sourceSvg = svg; fileName = name; groups = prepared.groups; shapes = prepared.shapes; warnings = prepared.warnings; viewBox = prepared.viewBox;
    selectedGroupKey = groups[0]?.key ?? null; selectedBoneId = null; selectedShapeKey = null; selectedShapeNodeIndex = null; poses = []; bones = []; setupBoneTransforms = {}; activePoseId = "rest"; undoStack = []; redoStack = []; projectPath = null; zoom = 1; canvasPan = { x: 0, y: 0 };
    svgHost.innerHTML = prepared.markup;
    requestAnimationFrame(() => { collectPivots(); applyAllTransforms(); });
    status = `${groups.length} editable group${groups.length === 1 ? "" : "s"} indexed`;
    dirty = persist;
    if (persist) schedulePersist();
  }
  async function replaceSvgSource(svg: string, name: string) {
    const prepared = prepareSvg(svg);
    const mapping = replacementGroupMap(groups, prepared.groups);
    const shapeMapping = replacementShapeMap(shapes, prepared.shapes, mapping);
    const mappedBindings = bones.filter((bone) => bone.groupKey && mapping[bone.groupKey]).length;
    const previousBindingCount = bones.filter((bone) => bone.groupKey).length;
    const previousSelection = selectedGroupKey;
    const previousShapeSelection = selectedShapeKey;
    const overriddenShapeKeys = new Set(poses.flatMap((pose) => [
      ...Object.keys(pose.shapePaths ?? {}),
      ...Object.keys(pose.shapeNodeModes ?? {}),
    ]));
    const mappedShapeOverrides = Array.from(overriddenShapeKeys).filter((key) => shapeMapping[key]).length;

    sourceSvg = svg;
    fileName = name;
    groups = prepared.groups;
    shapes = prepared.shapes;
    warnings = prepared.warnings;
    viewBox = prepared.viewBox;
    bones = bones.map((bone) => ({
      ...bone,
      groupKey: bone.groupKey ? mapping[bone.groupKey] ?? null : null,
    }));
    poses = poses.map((pose) => ({
      ...pose,
      transforms: remapGroupRecord(pose.transforms, mapping),
      visibility: remapGroupRecord(pose.visibility, mapping),
      shapePaths: remapShapeRecord(pose.shapePaths, shapeMapping),
      shapeNodeModes: remapShapeRecord(pose.shapeNodeModes, shapeMapping),
    }));
    selectedGroupKey = previousSelection ? mapping[previousSelection] ?? prepared.groups[0]?.key ?? null : prepared.groups[0]?.key ?? null;
    selectedShapeKey = previousShapeSelection ? shapeMapping[previousShapeSelection] ?? null : null;
    selectedShapeNodeIndex = null;
    undoStack = [];
    redoStack = [];
    drag = null;
    boneDrag = null;
    modalTool = null;
    setupFrozenMatrices = {};
    svgHost.innerHTML = prepared.markup;
    requestAnimationFrame(() => {
      collectPivots();
      applyAllTransforms();
      selectWrapper(svgHost, selectedGroupKey);
      if (selectedBoneId) highlightBoneWrapper(svgHost, bones.find((bone) => bone.id === selectedBoneId)?.groupKey ?? null);
    });
    dirty = true;
    schedulePersist();
    schedulePreview();
    const lost = previousBindingCount - mappedBindings;
    const droppedShapeOverrides = overriddenShapeKeys.size - mappedShapeOverrides;
    const curveStatus = overriddenShapeKeys.size
      ? ` · ${mappedShapeOverrides}/${overriddenShapeKeys.size} edited curve${overriddenShapeKeys.size === 1 ? "" : "s"} relinked${droppedShapeOverrides ? ` · ${droppedShapeOverrides} stale curve override${droppedShapeOverrides === 1 ? "" : "s"} removed` : ""}`
      : "";
    status = `SVG replaced · ${mappedBindings}/${previousBindingCount} rig binding${previousBindingCount === 1 ? "" : "s"} relinked${curveStatus}${lost ? ` · ${lost} rig needs review` : ""}`;
  }
  async function chooseSvg(mode: "new" | "replace") {
    try {
      if (isTauri()) {
        const path = await open({ multiple: false, directory: false, filters: [{ name: "Scalable Vector Graphics", extensions: ["svg"] }] });
        if (!path) return;
        const svg = await readTextFile(path);
        const name = path.split(/[\\/]/).pop() || "artwork.svg";
        if (mode === "replace" && sourceSvg) await replaceSvgSource(svg, name);
        else await loadSvgSource(svg, name);
      } else {
        svgImportMode = mode;
        fileInput.click();
      }
    } catch (error) { status = error instanceof Error ? error.message : String(error); }
  }
  async function openSvg() { await chooseSvg(sourceSvg ? "replace" : "new"); }
  async function newProject() { await chooseSvg("new"); }
  async function receiveFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement, file = input.files?.[0];
    if (!file) return;
    try {
      const svg = await file.text();
      if (svgImportMode === "replace" && sourceSvg) await replaceSvgSource(svg, file.name);
      else await loadSvgSource(svg, file.name);
    }
    catch (error) { status = error instanceof Error ? error.message : String(error); }
    finally { input.value = ""; }
  }
  function currentProjectState(): AstdProjectState {
    return {
      sourceSvg,
      sourceFileName: fileName,
      poses,
      bones,
      setupBoneTransforms,
      activePoseId,
      selectedGroupKey,
      selectedBoneId,
      outputWidth: Math.max(1, Math.round(outputWidth)),
      outputHeight: Math.max(1, Math.round(outputHeight)),
      antiAlias,
      resizeMode,
      aiPixelFilter,
      aiPaletteSize,
      pixelContourStrength,
      pixelDetailFloor,
      pixelCoverageThreshold,
      preferredRigEditMode,
      primaryView: viewMode,
      pixelVisible,
      playbackFps,
      onionSkin,
      onionSkinScope,
      onionSkinRadius,
      zoom,
    };
  }
  async function loadProjectContents(contents: string, pathOrName: string) {
    const project = decodeAstdProject(contents);
    const saved = project.state;
    await loadSvgSource(saved.sourceSvg, saved.sourceFileName, false);
    poses = saved.poses;
    bones = saved.bones;
    setupBoneTransforms = saved.setupBoneTransforms;
    activePoseId = poses.some((pose) => pose.id === saved.activePoseId) ? saved.activePoseId : "rest";
    selectedGroupKey = groups.some((group) => group.key === saved.selectedGroupKey) ? saved.selectedGroupKey : groups[0]?.key ?? null;
    selectedBoneId = bones.some((bone) => bone.id === saved.selectedBoneId) ? saved.selectedBoneId : null;
    outputWidth = saved.outputWidth; outputHeight = saved.outputHeight; antiAlias = saved.antiAlias; resizeMode = saved.resizeMode;
    aiPixelFilter = saved.aiPixelFilter; aiPaletteSize = saved.aiPaletteSize;
    pixelContourStrength = saved.pixelContourStrength; pixelDetailFloor = saved.pixelDetailFloor;
    pixelCoverageThreshold = saved.pixelCoverageThreshold;
    preferredRigEditMode = saved.preferredRigEditMode;
    rigEditMode = activePoseId === "rest" ? "setup" : preferredRigEditMode;
    viewMode = saved.primaryView; pixelVisible = saved.pixelVisible;
    if (!viewMode && !pixelVisible) viewMode = "vector";
    leftMode = viewMode === "rig" ? "rig" : "groups";
    playbackFps = saved.playbackFps; onionSkin = saved.onionSkin; onionSkinScope = saved.onionSkinScope; onionSkinRadius = saved.onionSkinRadius; zoom = saved.zoom; canvasPan = { x: 0, y: 0 };
    projectPath = pathOrName; undoStack = []; redoStack = []; dirty = false;
    requestAnimationFrame(() => {
      collectPivots();
      if (rigEditMode === "setup") setupFrozenMatrices = calculatedGroupMatrices();
      applyAllTransforms();
    });
    schedulePersist();
    status = `Project loaded · ${pathOrName.split(/[\\/]/).pop()}`;
  }
  async function openProject() {
    try {
      if (isTauri()) {
        const path = await open({ multiple: false, directory: false, filters: [{ name: "Asset Studio Project", extensions: ["astd"] }] });
        if (!path) return;
        await loadProjectContents(await readTextFile(path), path);
      } else projectFileInput.click();
    } catch (error) { status = error instanceof Error ? error.message : String(error); }
  }
  async function receiveProjectFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement, file = input.files?.[0];
    if (!file) return;
    try { await loadProjectContents(await file.text(), file.name); }
    catch (error) { status = error instanceof Error ? error.message : String(error); }
    finally { input.value = ""; }
  }
  async function saveProject(saveAs = false) {
    if (!sourceSvg) return;
    const contents = encodeAstdProject(currentProjectState());
    const defaultName = `${fileName.replace(/\.[^.]+$/i, "") || "asset"}.astd`;
    try {
      if (isTauri()) {
        const path = !saveAs && projectPath
          ? projectPath
          : await save({ defaultPath: projectPath ?? defaultName, filters: [{ name: "Asset Studio Project", extensions: ["astd"] }] });
        if (!path) return;
        await writeTextFile(path, contents);
        projectPath = path;
      } else {
        const blob = new Blob([contents], { type: "application/json" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob); link.download = defaultName; link.click(); URL.revokeObjectURL(link.href);
        projectPath = defaultName;
      }
      dirty = false; status = `Project saved · ${projectName}`; schedulePersist();
    } catch (error) { status = error instanceof Error ? error.message : String(error); }
  }
  function selectGroup(key: string, shapeKey: string | null = null): boolean {
    if (modalTool && selectedGroupKey !== key) {
      status = `${modalTool.toUpperCase()} is locked to ${selectedGroup?.label ?? "the current vector"} · press Esc to change selection`;
      return false;
    }
    selectedGroupKey = key;
    if (shapeKey !== selectedShapeKey) selectedShapeNodeIndex = null;
    selectedShapeKey = shapeKey;
    selectWrapper(svgHost, key);
    scheduleEditorOverlay();
    return true;
  }
  function clearEditorSelection() {
    selectedGroupKey = null;
    selectedBoneId = null;
    selectedShapeKey = null;
    selectedShapeNodeIndex = null;
    selectionOverlay = null;
    shapeEditor = null;
    selectWrapper(svgHost, null);
    highlightBoneWrapper(svgHost, null);
    scheduleEditorOverlay();
    status = "Selection cleared · Left / Right changes pose";
  }
  function stepPoseView(direction: -1 | 1) {
    const id = steppedPoseId(poses, activePoseId, direction);
    if (!id) { status = "Create at least one pose before using Left / Right navigation."; return; }
    choosePose(id);
    const pose = poses.find((item) => item.id === id);
    status = `Pose view · ${pose?.name ?? id}`;
  }
  function addPose() {
    if (!sourceSvg) return;
    const before = captureDocument();
    const pose = createPose(`Pose ${String(poses.length + 1).padStart(2, "0")}`, activePose?.transforms ?? {}, activePose?.boneTransforms ?? {}, activePose?.visibility ?? {}, activePose?.shapePaths ?? {}, activePose?.shapeNodeModes ?? {});
    poses = [...poses, pose]; activePoseId = pose.id; rigEditMode = preferredRigEditMode; dirty = false; applyAllTransforms(); schedulePersist();
    commitHistory("Create pose", before);
    status = `${pose.name} created as an independent pose`;
  }
  function duplicatePose() {
    if (!activePose) return;
    const before = captureDocument();
    const pose = createPose(`${activePose.name} copy`, activePose.transforms, activePose.boneTransforms, activePose.visibility, activePose.shapePaths, activePose.shapeNodeModes);
    poses = [...poses, pose]; activePoseId = pose.id; rigEditMode = preferredRigEditMode; dirty = false; applyAllTransforms(); schedulePersist();
    commitHistory("Duplicate pose", before);
  }
  function deletePose(pose: Pose) {
    const before = captureDocument();
    poses = poses.filter((item) => item.id !== pose.id);
    if (activePoseId === pose.id) { activePoseId = "rest"; rigEditMode = "setup"; }
    dirty = false; applyAllTransforms(); schedulePersist();
    commitHistory("Delete pose", before);
  }
  function choosePose(id: string, fromPlayback = false) {
    if (!fromPlayback && isPlaying) stopPlayback();
    activePoseId = id;
    rigEditMode = id === "rest" ? "setup" : preferredRigEditMode;
    requestAnimationFrame(() => { if (viewMode === "rig" && rigEditMode === "setup") setupFrozenMatrices = calculatedGroupMatrices(); applyAllTransforms(); });
  }
  function stopPlayback() {
    isPlaying = false;
    clearPixelPrerenderCache();
    if (playbackTimer) clearTimeout(playbackTimer);
    playbackTimer = null;
    if (viewMode === "rig" && rigEditMode === "setup") setupFrozenMatrices = calculatedGroupMatrices();
    applyAllTransforms();
  }
  function playbackStep() {
    if (!isPlaying) return;
    const frames = poses.map((pose) => pose.id);
    if (frames.length === 0) return;
    const current = Math.max(0, frames.indexOf(activePoseId));
    choosePose(frames[(current + 1) % frames.length], true);
    playbackTimer = setTimeout(playbackStep, 1000 / playbackFps);
  }
  async function togglePlayback() {
    if (isPlaying) { stopPlayback(); status = "Pose playback stopped"; return; }
    if (!sourceSvg || poses.length === 0) { status = "Create at least one pose to play the animation."; return; }
    clearPixelPrerenderCache();
    activePoseId = poses[0].id;
    rigEditMode = preferredRigEditMode;
    isPlaying = true;
    applyAllTransforms();
    const generation = pixelPrerenderGeneration;
    status = `Preparing ${poses.length} pixel frame${poses.length === 1 ? "" : "s"} before playback…`;
    await prerenderPixelFrames();
    if (!isPlaying || generation !== pixelPrerenderGeneration) return;
    playbackTimer = setTimeout(playbackStep, 1000 / playbackFps);
    status = `Playing ${poses.length} pose${poses.length === 1 ? "" : "s"} at ${playbackFps} FPS · pixel cache ready`;
  }
  function toggleOnionSkin() {
    onionSkin = !onionSkin;
    dirty = true;
    schedulePreview();
    schedulePersist();
    status = onionSkin
      ? "Onion skin enabled · previous red 40% · next blue 40%"
      : "Onion skin disabled";
  }
  function toggleOnionSkinScope() {
    onionSkinScope = onionSkinScope === "all" ? "selected" : "all";
    dirty = true;
    schedulePreview();
    schedulePersist();
    status = onionSkinScope === "all"
      ? "Onion skin scope · all vectors"
      : selectedBone?.groupKey
        ? `Onion skin scope · ${selectedBone.name} vector`
        : "Select a bound bone to show its onion vector";
  }
  function changeOnionSkinRadius(event: Event) {
    onionSkinRadius = Math.max(1, Math.min(8, Math.round(Number((event.currentTarget as HTMLSelectElement).value) || 1)));
    dirty = true;
    schedulePreview();
    schedulePersist();
    status = `Onion skin neighbor level · ${onionSkinRadius}`;
  }
  function onionSkinBoneGroups(): Set<string> | undefined {
    if (onionSkinScope !== "selected" || !selectedBone?.groupKey) return undefined;
    const distances = new Map<string, number>([[selectedBone.id, 0]]);
    const frontier = [selectedBone.id];
    const maxDistance = Math.max(0, onionSkinRadius - 1);
    while (frontier.length > 0) {
      const boneId = frontier.shift()!;
      const distance = distances.get(boneId) ?? 0;
      if (distance >= maxDistance) continue;
      for (const neighbor of bones) {
        const connected = neighbor.id === boneId
          ? false
          : neighbor.parentId === boneId || bones.find((item) => item.id === boneId)?.parentId === neighbor.id;
        if (!connected || distances.has(neighbor.id)) continue;
        distances.set(neighbor.id, distance + 1);
        frontier.push(neighbor.id);
      }
    }
    return new Set(bones.filter((bone) => distances.has(bone.id) && bone.groupKey).map((bone) => bone.groupKey!));
  }
  function changePlaybackFps(event: Event) {
    playbackFps = Number((event.currentTarget as HTMLSelectElement).value) || 2;
    if (isPlaying) { if (playbackTimer) clearTimeout(playbackTimer); playbackTimer = setTimeout(playbackStep, 1000 / playbackFps); }
    dirty = true; schedulePersist();
  }
  function renamePose(event: Event) {
    if (!activePose) return;
    const name = (event.currentTarget as HTMLInputElement).value.trim();
    if (name && name !== activePose.name) {
      const before = captureDocument();
      poses = poses.map((pose) => pose.id === activePose.id ? { ...pose, name } : pose);
      commitHistory("Rename pose", before); schedulePersist();
    }
  }
  function updateTransform(key: string, next: GroupTransform, preview = true, record = true) {
    if (!activePose) return;
    const before = record ? captureDocument() : null;
    poses = poses.map((pose) => pose.id === activePose.id ? { ...pose, transforms: { ...pose.transforms, [key]: { ...next } } } : pose);
    applyAllTransforms(); dirty = true;
    if (preview) schedulePreview();
    schedulePersist();
    if (before) commitHistory("Transform group", before);
  }

  function toggleGroupVisibility(group: SvgGroup, event: MouseEvent) {
    event.stopPropagation();
    if (!activePose) { status = "REST is protected. Create a pose to change layer visibility."; return; }
    const before = captureDocument();
    const visible = !groupIsVisible(group.key);
    poses = poses.map((pose) => pose.id === activePose.id
      ? { ...pose, visibility: { ...(pose.visibility ?? {}), [group.key]: visible } }
      : pose);
    applyAllTransforms(); dirty = true; schedulePersist();
    commitHistory(`${visible ? "Show" : "Hide"} ${group.label}`, before);
    status = `${group.label} ${visible ? "shown" : "hidden"} in ${activePose.name}`;
  }
  function changeTransform(field: keyof GroupTransform, event: Event) {
    if (!selectedGroupKey || !activePose) return;
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(value)) updateTransform(selectedGroupKey, { ...currentTransform(selectedGroupKey), [field]: value });
  }
  function resetSelectedGroupToRest() {
    if (!selectedGroupKey || !activePose) return;
    const before = captureDocument();
    const groupKey = selectedGroupKey;
    const groupLabel = selectedGroup?.label ?? "Group";
    const poseId = activePose.id;
    const poseName = activePose.name;
    const shapeKeys = new Set(
      Array.from(svgHost.querySelectorAll(`[data-studio-shape-group="${CSS.escape(groupKey)}"]`))
        .map((element) => (element as SVGElement).dataset.studioShape)
        .filter((key): key is string => Boolean(key)),
    );
    poses = poses.map((pose) => {
      if (pose.id !== poseId) return pose;
      const transforms = { ...pose.transforms };
      const visibility = { ...(pose.visibility ?? {}) };
      const shapePaths = { ...(pose.shapePaths ?? {}) };
      const shapeNodeModes = { ...(pose.shapeNodeModes ?? {}) };
      delete transforms[groupKey];
      delete visibility[groupKey];
      for (const shapeKey of shapeKeys) {
        delete shapePaths[shapeKey];
        delete shapeNodeModes[shapeKey];
      }
      return { ...pose, transforms, visibility, shapePaths, shapeNodeModes };
    });
    applyAllTransforms();
    commitHistory(`Reset ${groupLabel} to Rest`, before);
    dirty = true;
    schedulePreview();
    schedulePersist();
    status = `${groupLabel} restored to Rest in ${poseName}`;
  }
  function currentShapeNodeModes(): Record<string, NodeMode> {
    if (!activePose || !shapeEditor) return {};
    return { ...(activePose.shapeNodeModes?.[shapeEditor.shapeKey] ?? {}) };
  }
  function updateShapeCommands(commands: PathCommand[], nodeModes?: Record<string, NodeMode>) {
    if (!activePose || !shapeEditor) return;
    const d = serializePathData(commands);
    const shapeKey = shapeEditor.shapeKey;
    poses = poses.map((pose) => pose.id === activePose.id
      ? {
        ...pose,
        shapePaths: { ...(pose.shapePaths ?? {}), [shapeKey]: d },
        shapeNodeModes: nodeModes
          ? { ...(pose.shapeNodeModes ?? {}), [shapeKey]: { ...nodeModes } }
          : pose.shapeNodeModes ?? {},
      }
      : pose);
    applyShapePath(svgHost, shapeKey, d);
    shapeEditor = {
      ...shapeEditor,
      d,
      commands,
      handles: pathHandles(commands),
      guides: pathControlGuides(commands),
      currentArea: pathArea(commands),
    };
    dirty = true;
    scheduleEditorOverlay();
    schedulePreview();
    schedulePersist();
  }
  function shiftNodeModes(modes: Record<string, NodeMode>, pivot: number, delta: 1 | -1): Record<string, NodeMode> {
    return Object.fromEntries(Object.entries(modes).flatMap(([key, mode]) => {
      const index = Number(key);
      if (!Number.isInteger(index)) return [];
      if (delta === 1) return [[String(index >= pivot ? index + 1 : index), mode]];
      if (index === pivot) return [];
      return [[String(index > pivot ? index - 1 : index), mode]];
    }));
  }
  function addShapeNode() {
    if (!activePose || !shapeEditor || selectedShapeNodeIndex === null) { status = "Select an anchor before adding a node."; return; }
    const result = addPathNodeAfter(shapeEditor.commands, selectedShapeNodeIndex);
    if (!result) { status = "This segment cannot accept another node."; return; }
    const before = captureDocument();
    const inheritedMode = selectedShapeNodeMode;
    const modes = shiftNodeModes(currentShapeNodeModes(), result.nodeIndex, 1);
    modes[String(result.nodeIndex)] = inheritedMode;
    selectedShapeNodeIndex = result.nodeIndex;
    updateShapeCommands(result.commands, modes);
    commitHistory("Add vector node", before);
    status = `Node added without changing the curve · ${shapeVolumePercent.toFixed(1)}% volume`;
  }
  function removeSelectedShapeNode() {
    if (!activePose || !shapeEditor || selectedShapeNodeIndex === null) { status = "Select an anchor before removing a node."; return; }
    const result = removePathNode(shapeEditor.commands, selectedShapeNodeIndex);
    if (!result) { status = "A closed shape needs at least three nodes."; return; }
    const before = captureDocument();
    const removedIndex = selectedShapeNodeIndex;
    const modes = shiftNodeModes(currentShapeNodeModes(), removedIndex, -1);
    selectedShapeNodeIndex = result.nodeIndex;
    updateShapeCommands(result.commands, modes);
    commitHistory("Remove vector node", before);
    status = `Node removed · ${shapeVolumePercent.toFixed(1)}% volume`;
  }
  function setSelectedShapeNodeMode(mode: NodeMode) {
    if (!activePose || !shapeEditor || selectedShapeNodeIndex === null) { status = "Select an anchor to change its behavior."; return; }
    const before = captureDocument();
    const modes = currentShapeNodeModes();
    modes[String(selectedShapeNodeIndex)] = mode;
    const commands = configurePathNode(shapeEditor.commands, selectedShapeNodeIndex, mode);
    updateShapeCommands(commands, modes);
    commitHistory(`Convert node to ${mode}`, before);
    status = mode === "sharp" ? "Corner node · pullers removed" : mode === "smooth" ? "Smooth node · two independent pullers" : "Smart node · two linked pullers stay aligned and balanced";
  }
  function resetSelectedShape() {
    if (!activePose || !shapeEditor) return;
    const before = captureDocument();
    const shapeKey = shapeEditor.shapeKey;
    poses = poses.map((pose) => {
      if (pose.id !== activePose.id) return pose;
      const shapePaths = { ...(pose.shapePaths ?? {}) };
      const shapeNodeModes = { ...(pose.shapeNodeModes ?? {}) };
      delete shapePaths[shapeKey];
      delete shapeNodeModes[shapeKey];
      return { ...pose, shapePaths, shapeNodeModes };
    });
    applyShapePath(svgHost, shapeKey, null);
    commitHistory("Reset vector shape", before);
    dirty = true;
    scheduleEditorOverlay();
    schedulePreview();
    schedulePersist();
    status = "Vector shape restored to 100% source volume";
  }
  function selectEditorTool(tool: EditorTool) {
    if (modalTool) exitModalTransform(false);
    activeTool = tool;
    scheduleEditorOverlay();
    status = tool === "shape" ? "Node tool · select a shape, then drag anchors or Bézier controls" : `${tool[0].toUpperCase()}${tool.slice(1)} tool`;
  }
  function enterModalTransform(tool: ModalTransformTool) {
    if (!viewMode) { status = "Open Vector or Rig before starting a transform."; return; }
    if (viewMode === "rig" && !selectedBone) { status = `Select a bone before pressing ${tool === "move" ? "G" : tool === "rotate" ? "R" : "S"}.`; return; }
    if (viewMode === "vector" && !selectedGroup) { status = `Select a vector group before pressing ${tool === "move" ? "G" : tool === "rotate" ? "R" : "S"}.`; return; }
    if (viewMode === "vector" && !activePose) { status = "REST is protected. Create or select a pose before transforming artwork."; return; }
    if (!modalTool) modalReturnTool = activeTool;
    modalTool = tool;
    activeTool = tool;
    scheduleEditorOverlay();
    status = `${tool.toUpperCase()} LOCKED · drag anywhere on the canvas · Esc to exit`;
  }
  function exitModalTransform(cancelGesture: boolean) {
    if (cancelGesture) {
      const before = drag?.historyBefore ?? boneDrag?.historyBefore;
      if (before) restoreDocument(before);
      drag = null;
      boneDrag = null;
    }
    if (!modalTool) return;
    const exited = modalTool;
    modalTool = null;
    activeTool = modalReturnTool;
    scheduleEditorOverlay();
    status = `${exited.toUpperCase()} lock released`;
  }
  function selectBone(id: string): boolean {
    if (modalTool && selectedBoneId !== id) {
      status = `${modalTool.toUpperCase()} is locked to ${selectedBone?.name ?? "the current bone"} · press Esc to change selection`;
      return false;
    }
    selectedBoneId = id;
    highlightBoneWrapper(svgHost, bones.find((bone) => bone.id === id)?.groupKey ?? null);
    if (viewMode !== "rig") showRig(); else leftMode = "rig";
    return true;
  }
  function fittedBoneForGroup(bone: Bone, groupKey: string): { bone: Bone; setup: BonePoseTransform } | null {
    const wrapper = svgHost?.querySelector(`[data-studio-group="${CSS.escape(groupKey)}"]`) as SVGGElement | null;
    if (!wrapper) return null;
    try {
      const box = wrapper.getBBox();
      const currentWorld = boneWorlds[bone.id] ?? boneWorldMap(
        [...bones, bone],
        { ...effectiveBoneTransforms(activePose), [bone.id]: identityBoneTransform() },
      )[bone.id];
      let fitted = fitBoneToGroupBounds({
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        localToRoot: wrapperParentMatrices[groupKey] ?? [1, 0, 0, 1, 0, 0],
      }, 0.08, Math.max(2, Math.min(viewBox[2], viewBox[3]) * 0.01), currentWorld ? {
        x: currentWorld.endX - currentWorld.startX,
        y: currentWorld.endY - currentWorld.startY,
      } : undefined);
      if (!fitted) return null;

      const parentTip = bone.parentId ? boneWorlds[bone.parentId] : null;
      if (parentTip) fitted = orientBoneStartToward(fitted, { x: parentTip.endX, y: parentTip.endY });

      const parentMatrix = bone.parentId ? boneWorlds[bone.parentId]?.matrix : null;
      const parentInverse = parentMatrix ? invertMatrix(parentMatrix) : [1, 0, 0, 1, 0, 0] as Matrix;
      const localStart = pointWithMatrix(parentInverse, fitted.startX, fitted.startY);
      const localEnd = pointWithMatrix(parentInverse, fitted.endX, fitted.endY);
      const dx = localEnd.x - localStart.x;
      const dy = localEnd.y - localStart.y;
      return {
        bone: {
          ...bone,
          x: localStart.x,
          y: localStart.y,
          length: Math.max(1, Math.hypot(dx, dy)),
          restRotation: Math.atan2(dy, dx) * 180 / Math.PI,
        },
        // The base geometry becomes the fitted placement. Compensating the
        // active pose keeps Setup and Pose visually identical at fit time.
        setup: relativeBoneTransform(identityBoneTransform(), currentBoneTransform(bone.id)),
      };
    } catch {
      return null;
    }
  }
  function fitSelectedBoneToGroup() {
    if (!selectedBone?.groupKey || rigEditMode !== "setup") return;
    const before = captureDocument();
    const fitted = fittedBoneForGroup(selectedBone, selectedBone.groupKey);
    if (!fitted) { status = "The bound group has no measurable artwork to fit."; return; }
    bones = bones.map((bone) => bone.id === fitted.bone.id ? fitted.bone : bone);
    setupBoneTransforms = { ...setupBoneTransforms, [fitted.bone.id]: fitted.setup };
    applyAllTransforms(); schedulePersist();
    commitHistory("Fit bone to group", before);
    status = `${fitted.bone.name} centered and fitted to ${groups.find((group) => group.key === fitted.bone.groupKey)?.label}`;
  }
  function rigGroupTargets(): RigGroupTarget[] {
    return groups.flatMap((group, order) => {
      const wrapper = svgHost.querySelector(`[data-studio-group="${CSS.escape(group.key)}"]`) as SVGGElement | null;
      const matrix = wrapperParentMatrices[group.key];
      if (!wrapper || !matrix) return [];
      try {
        const box = wrapper.getBBox();
        const center = pointWithMatrix(matrix, box.x + box.width / 2, box.y + box.height / 2);
        const width = Math.hypot(matrix[0] * box.width, matrix[1] * box.width);
        const height = Math.hypot(matrix[2] * box.height, matrix[3] * box.height);
        const diameter = Math.max(width, height);
        return diameter > 1e-6 ? [{ key: group.key, centerX: center.x, centerY: center.y, diameter, order }] : [];
      } catch {
        return [];
      }
    });
  }
  function addBone() {
    if (!sourceSvg) return;
    const before = captureDocument();
    const parent = bones.find((bone) => bone.id === selectedBoneId) ?? null;
    const parentWorld = parent ? boneWorlds[parent.id] : null;
    const occupiedGroups = new Set(bones.flatMap((bone) => bone.groupKey ? [bone.groupKey] : []));
    const targetGroupKey = parent && parentWorld
      ? childBoneTargetGroup(parent.groupKey ?? selectedGroupKey, parentWorld, rigGroupTargets(), occupiedGroups)
      : selectedGroupKey;
    const pivot = targetGroupKey ? worldPivots[targetGroupKey] : null;
    const group = groups.find((item) => item.key === targetGroupKey);
    const targetDistance = parentWorld && pivot ? Math.hypot(pivot.x - parentWorld.endX, pivot.y - parentWorld.endY) : 0;
    const targetAngle = parentWorld && pivot ? Math.atan2(pivot.y - parentWorld.endY, pivot.x - parentWorld.endX) * 180 / Math.PI : 0;
    const bone: Bone = {
      id: crypto.randomUUID(),
      name: group?.label ?? `Bone ${String(bones.length + 1).padStart(2, "0")}`,
      parentId: parent?.id ?? null,
      groupKey: targetGroupKey,
      x: parent ? parent.length : (pivot?.x ?? viewBox[0] + viewBox[2] / 2),
      y: parent ? 0 : (pivot?.y ?? viewBox[1] + viewBox[3] / 2),
      length: parent ? Math.max(12, targetDistance || parent.length * 0.72) : Math.max(32, Math.min(viewBox[2], viewBox[3]) * 0.16),
      restRotation: parentWorld && pivot ? targetAngle - parentWorld.angle : 0,
    };
    const groupAlreadyRigged = Boolean(bone.groupKey && bones.some((item) => item.groupKey === bone.groupKey));
    const fitted = bone.groupKey && !groupAlreadyRigged ? fittedBoneForGroup(bone, bone.groupKey) : null;
    const placedBone = fitted?.bone ?? bone;
    bones = [...bones, placedBone];
    if (fitted) setupBoneTransforms = { ...setupBoneTransforms, [placedBone.id]: fitted.setup };
    selectedBoneId = placedBone.id; selectedGroupKey = placedBone.groupKey; showRig();
    applyAllTransforms(); schedulePersist();
    commitHistory("Add bone", before);
    status = fitted
      ? `${placedBone.name} centered and fitted to ${group?.label}`
      : groupAlreadyRigged
        ? `${placedBone.name} added to ${group?.label} · multiple pose bones will deform its Bézier nodes at constant volume`
        : parent ? `${placedBone.name} added as a child of ${parent.name}` : `${placedBone.name} root created`;
  }
  function updateBone(next: Bone, label = "Edit bone") {
    const before = captureDocument();
    bones = bones.map((bone) => bone.id === next.id ? { ...next } : bone);
    applyAllTransforms(); schedulePersist();
    commitHistory(label, before);
  }
  function changeBoneNumber(field: "x" | "y" | "length" | "restRotation", event: Event) {
    if (!selectedBone) return;
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    updateBone({ ...selectedBone, [field]: field === "length" ? Math.max(1, value) : value });
  }
  function changeBoneName(event: Event) {
    if (!selectedBone) return;
    const name = (event.currentTarget as HTMLInputElement).value.trim();
    if (name) updateBone({ ...selectedBone, name });
  }
  function changeBoneParent(event: Event) {
    if (!selectedBone) return;
    const parentId = (event.currentTarget as HTMLSelectElement).value || null;
    if (wouldCreateCycle(selectedBone.id, parentId, bones)) { status = "That parent would create a bone cycle."; return; }
    updateBone({ ...selectedBone, parentId });
  }
  function changeBoneBinding(event: Event) {
    if (!selectedBone) return;
    const before = captureDocument();
    const groupKey = (event.currentTarget as HTMLSelectElement).value || null;
    const groupAlreadyRigged = Boolean(groupKey && bones.some((bone) => bone.id !== selectedBone.id && bone.groupKey === groupKey));
    const fitted = groupKey && !groupAlreadyRigged ? fittedBoneForGroup({ ...selectedBone, groupKey }, groupKey) : null;
    const groupLabel = groups.find((group) => group.key === groupKey)?.label;
    const nextSelected = {
      ...(fitted?.bone ?? { ...selectedBone, groupKey }),
      ...(groupKey && groupLabel ? { name: groupLabel } : {}),
    };
    bones = bones.map((bone) => bone.id === selectedBone.id ? nextSelected : bone);
    if (fitted) setupBoneTransforms = { ...setupBoneTransforms, [selectedBone.id]: fitted.setup };
    applyAllTransforms(); schedulePersist();
    commitHistory(groupKey ? "Bind and fit bone to group" : "Unbind bone from group", before);
    status = groupKey
      ? fitted
        ? `${nextSelected.name} bound, centered, and fitted to ${groupLabel}`
        : groupAlreadyRigged
          ? `${nextSelected.name} joined ${groupLabel} · Pose changes will deform its nodes at constant volume`
          : `${nextSelected.name} bound to an empty group`
      : `${selectedBone.name} unbound`;
  }
  function deleteBone() {
    if (!selectedBone) return;
    const before = captureDocument();
    const removed = new Set([selectedBone.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const bone of bones) if (bone.parentId && removed.has(bone.parentId) && !removed.has(bone.id)) { removed.add(bone.id); changed = true; }
    }
    bones = bones.filter((bone) => !removed.has(bone.id));
    setupBoneTransforms = Object.fromEntries(Object.entries(setupBoneTransforms).filter(([id]) => !removed.has(id)));
    poses = poses.map((pose) => ({ ...pose, boneTransforms: Object.fromEntries(Object.entries(pose.boneTransforms ?? {}).filter(([id]) => !removed.has(id))) }));
    selectedBoneId = null; applyAllTransforms(); schedulePersist();
    commitHistory("Delete bone chain", before);
    status = `${removed.size} bone${removed.size === 1 ? "" : "s"} removed`;
  }
  function currentSetupBoneTransform(id: string): BonePoseTransform { return setupBoneTransforms[id] ?? identityBoneTransform(); }
  function currentBoneTransform(id: string): BonePoseTransform { return activePose?.boneTransforms[id] ?? identityBoneTransform(); }
  function effectiveBoneTransform(id: string, pose: Pose | null = activePose): BonePoseTransform {
    return composeBoneTransform(currentSetupBoneTransform(id), pose?.boneTransforms[id] ?? identityBoneTransform());
  }
  function effectiveBoneTransforms(pose: Pose | null): Record<string, BonePoseTransform> {
    return Object.fromEntries(bones.map((bone) => [bone.id, effectiveBoneTransform(bone.id, pose)]));
  }
  function updateSetupBoneTransform(id: string, transform: BonePoseTransform, preview = true, record = true) {
    const before = record ? captureDocument() : null;
    setupBoneTransforms = { ...setupBoneTransforms, [id]: { ...transform } };
    applyAllTransforms(); dirty = true;
    if (preview) schedulePreview();
    schedulePersist();
    if (before) commitHistory("Adjust rig setup", before);
  }
  function directChildWorldMatrices(parentId: string): Record<string, Matrix> {
    return Object.fromEntries(bones.flatMap((bone) => {
      const world = bone.parentId === parentId ? boneWorlds[bone.id] : null;
      return world ? [[bone.id, [...world.matrix] as Matrix]] : [];
    }));
  }
  function updateSetupBoneScaleWithoutScalingChildren(
    id: string,
    transform: BonePoseTransform,
    startParentMatrix: Matrix | null = boneWorlds[id]?.matrix ?? null,
    startChildMatrices: Record<string, Matrix> = directChildWorldMatrices(id),
    preview = true,
    record = true,
  ) {
    const before = record ? captureDocument() : null;
    let nextSetup = { ...setupBoneTransforms, [id]: { ...transform } };

    if (startParentMatrix) {
      const provisionalTransforms = Object.fromEntries(bones.map((bone) => [
        bone.id,
        composeBoneTransform(nextSetup[bone.id] ?? identityBoneTransform(), currentBoneTransform(bone.id)),
      ]));
      const provisionalWorlds = boneWorldMap(bones, provisionalTransforms);
      const nextParent = provisionalWorlds[id];
      if (nextParent) {
        for (const [childId, startChildMatrix] of Object.entries(startChildMatrices)) {
          const child = bones.find((bone) => bone.id === childId);
          if (!child || child.parentId !== id) continue;

          // The joint follows its scaled parent, while the child's world-space
          // basis stays unchanged. This prevents Setup fitting from stretching
          // or rotating the child chain; Pose mode intentionally keeps normal
          // inherited scaling.
          const desiredChildWorld = childWorldMatrixWithoutInheritedScale(startParentMatrix, nextParent.matrix, startChildMatrix);
          const desiredChildLocal = multiplyMatrix(invertMatrix(nextParent.matrix), desiredChildWorld);
          const effectiveChild = boneTransformFromLocalMatrix(child, desiredChildLocal);
          nextSetup[childId] = relativeBoneTransform(effectiveChild, currentBoneTransform(childId));
        }
      }
    }

    setupBoneTransforms = nextSetup;
    applyAllTransforms(); dirty = true;
    if (preview) schedulePreview();
    schedulePersist();
    if (before) commitHistory("Scale rig setup", before);
  }
  function updateBonePose(id: string, transform: BonePoseTransform, preview = true, record = true) {
    if (!activePose) return;
    const before = record ? captureDocument() : null;
    poses = poses.map((pose) => pose.id === activePose.id ? { ...pose, boneTransforms: { ...(pose.boneTransforms ?? {}), [id]: { ...transform } } } : pose);
    applyAllTransforms(); dirty = true;
    if (preview) schedulePreview();
    schedulePersist();
    if (before) commitHistory("Pose bone", before);
  }
  function changeBoneRotation(event: Event) {
    if (!selectedBone || (rigEditMode === "pose" && !activePose)) return;
    const rotation = Number((event.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(rotation)) return;
    if (rigEditMode === "setup") updateSetupBoneTransform(selectedBone.id, { ...currentSetupBoneTransform(selectedBone.id), rotation });
    else updateBonePose(selectedBone.id, { ...currentBoneTransform(selectedBone.id), rotation });
  }
  function resetSelectedBoneToRest() {
    if (!selectedBone) return;
    if (rigEditMode === "pose" && !activePose) return;
    const before = captureDocument();
    const boneId = selectedBone.id;
    const boneName = selectedBone.name;
    const poseId = activePose?.id;
    const poseName = activePose?.name;
    if (rigEditMode === "setup") {
      const next = { ...setupBoneTransforms };
      delete next[boneId];
      setupBoneTransforms = next;
    } else if (activePose) {
      poses = poses.map((pose) => {
        if (pose.id !== poseId) return pose;
        const boneTransforms = { ...(pose.boneTransforms ?? {}) };
        delete boneTransforms[boneId];
        return { ...pose, boneTransforms };
      });
    }
    applyAllTransforms();
    commitHistory(`Reset ${boneName} to Rest`, before);
    dirty = true;
    schedulePreview();
    schedulePersist();
    status = `${boneName} restored to ${rigEditMode === "setup" ? "base rig placement" : `Rest in ${poseName}`}`;
  }
  function changeBonePoseNumber(field: keyof BonePoseTransform, event: Event) {
    if (!selectedBone || (rigEditMode === "pose" && !activePose)) return;
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    const current = rigEditMode === "setup" ? currentSetupBoneTransform(selectedBone.id) : currentBoneTransform(selectedBone.id);
    const next = { ...current, [field]: field.startsWith("scale") ? Math.max(0.02, value) : value };
    if (rigEditMode === "setup" && field.startsWith("scale")) updateSetupBoneScaleWithoutScalingChildren(selectedBone.id, next);
    else if (rigEditMode === "setup") updateSetupBoneTransform(selectedBone.id, next);
    else updateBonePose(selectedBone.id, next);
  }
  function pointWithMatrix(matrix: Matrix, x: number, y: number) {
    return { x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] };
  }
  function scalePair(factorX: number, factorY: number, startX: number, startY: number) {
    const safeX = Math.max(0.02, Math.abs(factorX));
    const safeY = Math.max(0.02, Math.abs(factorY));
    if (preserveArea) return { x: startX * safeX, y: startY / safeX };
    if (lockRatio) {
      const uniform = Math.max(0.02, Math.abs(safeX) > Math.abs(safeY) ? safeX : safeY);
      return { x: startX * uniform, y: startY * uniform };
    }
    return { x: startX * safeX, y: startY * safeY };
  }
  function applyBoneGeometry(state: BoneDragState, worldStart: { x: number; y: number }, worldEnd: { x: number; y: number }) {
    const localStart = pointWithMatrix(state.parentInverse, worldStart.x, worldStart.y);
    const localEnd = pointWithMatrix(state.parentInverse, worldEnd.x, worldEnd.y);
    const localDx = localEnd.x - localStart.x;
    const localDy = localEnd.y - localStart.y;
    const localLength = Math.max(1, Math.hypot(localDx, localDy));
    const localAngle = Math.atan2(localDy, localDx) * 180 / Math.PI;
    const scaleX = Math.max(0.02, localLength / Math.max(1, state.startBone.length));
    let scaleY = state.startEffective.scaleY;
    if (state.gesture.startsWith("scale")) {
      const factor = scaleX / Math.max(0.02, state.startEffective.scaleX);
      if (preserveArea) scaleY = state.startEffective.scaleY / Math.max(0.02, factor);
      else if (lockRatio) scaleY = state.startEffective.scaleY * factor;
    }
    const effective: BonePoseTransform = {
      x: localStart.x - state.startBone.x,
      y: localStart.y - state.startBone.y,
      rotation: localAngle - state.startBone.restRotation,
      scaleX,
      scaleY,
    };
    if (rigEditMode === "setup" && state.gesture.startsWith("scale")) {
      updateSetupBoneScaleWithoutScalingChildren(
        state.boneId,
        relativeBoneTransform(effective, state.startPose),
        state.startMatrix,
        state.startChildMatrices,
        false,
        false,
      );
    } else if (rigEditMode === "setup") updateSetupBoneTransform(state.boneId, relativeBoneTransform(effective, state.startPose), false, false);
    else updateBonePose(state.boneId, relativeBoneTransform(effective, state.startSetup), false, false);
  }
  function bonePointerDown(event: PointerEvent, boneId: string, gesture: BoneGesture) {
    if (event.button !== 0) return;
    if (!selectBone(boneId)) return;
    if (rigEditMode === "pose" && !activePose) { status = "Create a pose before entering Pose mode."; return; }
    const inverse = rigSvg?.getScreenCTM()?.inverse();
    if (!inverse) return;
    const bone = bones.find((item) => item.id === boneId);
    const world = boneWorlds[boneId];
    if (!bone || !world) return;
    const startPoint = new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse);
    const parentMatrix = bone.parentId ? boneWorlds[bone.parentId]?.matrix : null;
    boneDrag = {
      pointerId: event.pointerId,
      boneId,
      gesture,
      inverse,
      startPoint,
      startBone: { ...bone },
      startSetup: { ...currentSetupBoneTransform(boneId) },
      startPose: { ...currentBoneTransform(boneId) },
      startEffective: { ...effectiveBoneTransform(boneId) },
      parentInverse: parentMatrix ? invertMatrix(parentMatrix) : [1, 0, 0, 1, 0, 0],
      startMatrix: [...world.matrix] as Matrix,
      startWorld: { startX: world.startX, startY: world.startY, endX: world.endX, endY: world.endY },
      startChildMatrices: directChildWorldMatrices(boneId),
      historyBefore: captureDocument(),
    };
    rigSvg?.setPointerCapture(event.pointerId);
    event.preventDefault(); event.stopPropagation();
  }
  function boneOverlayPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    if (modalTool) {
      if (!selectedBoneId) return;
      const gesture: BoneGesture = modalTool === "move" ? "move" : modalTool === "rotate" ? "rotate-end" : "scale-end";
      bonePointerDown(event, selectedBoneId, gesture);
      return;
    }
    const target = (event.target as Element).closest<SVGElement>("[data-bone-gesture]");
    const boneId = target?.dataset.boneId;
    const gesture = target?.dataset.boneGesture as BoneGesture | undefined;
    if (boneId && gesture) bonePointerDown(event, boneId, gesture);
  }
  function bonePointerMove(event: PointerEvent) {
    if (!boneDrag || boneDrag.pointerId !== event.pointerId) return;
    const bone = bones.find((item) => item.id === boneDrag?.boneId);
    if (!bone) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(boneDrag.inverse);
    const start = boneDrag.startWorld;
    const dx = start.endX - start.startX;
    const dy = start.endY - start.startY;
    const length = Math.max(1, Math.hypot(dx, dy));
    const unit = { x: dx / length, y: dy / length };
    if (boneDrag.gesture === "move") {
      const delta = { x: point.x - boneDrag.startPoint.x, y: point.y - boneDrag.startPoint.y };
      const translated = translateBoneEndpoints(start, delta);
      applyBoneGeometry(boneDrag, translated.start, translated.end);
    } else if (boneDrag.gesture === "rotate-end") {
      const baseAngle = Math.atan2(dy, dx);
      const startPointerAngle = Math.atan2(boneDrag.startPoint.y - start.startY, boneDrag.startPoint.x - start.startX);
      const currentPointerAngle = Math.atan2(point.y - start.startY, point.x - start.startX);
      const angle = modalTool === "rotate" ? baseAngle + currentPointerAngle - startPointerAngle : currentPointerAngle;
      applyBoneGeometry(boneDrag, { x: start.startX, y: start.startY }, { x: start.startX + Math.cos(angle) * length, y: start.startY + Math.sin(angle) * length });
    } else if (boneDrag.gesture === "rotate-start") {
      const angleFromEnd = Math.atan2(point.y - start.endY, point.x - start.endX);
      const worldStart = { x: start.endX + Math.cos(angleFromEnd) * length, y: start.endY + Math.sin(angleFromEnd) * length };
      applyBoneGeometry(boneDrag, worldStart, { x: start.endX, y: start.endY });
    } else if (boneDrag.gesture === "scale-end") {
      const nextLength = modalTool === "scale"
        ? Math.max(1, length + (point.x - boneDrag.startPoint.x) * unit.x + (point.y - boneDrag.startPoint.y) * unit.y)
        : Math.max(1, (point.x - start.startX) * unit.x + (point.y - start.startY) * unit.y);
      applyBoneGeometry(boneDrag, { x: start.startX, y: start.startY }, { x: start.startX + unit.x * nextLength, y: start.startY + unit.y * nextLength });
    } else {
      const nextLength = Math.max(1, (start.endX - point.x) * unit.x + (start.endY - point.y) * unit.y);
      applyBoneGeometry(boneDrag, { x: start.endX - unit.x * nextLength, y: start.endY - unit.y * nextLength }, { x: start.endX, y: start.endY });
    }
  }
  function bonePointerUp(event: PointerEvent) {
    if (!boneDrag || boneDrag.pointerId !== event.pointerId) return;
    const completed = boneDrag;
    const before = completed.historyBefore;
    boneDrag = null;
    commitHistory("Transform bone", before);
    schedulePreview();
    status = rigEditMode === "setup" ? "Guide placement updated; binding preserved" : `${activePose?.name ?? "Pose"} rig transform updated`;
  }
  function pointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    if (viewMode === "rig") return;
    const hitWrapper = (event.target as Element).closest("[data-studio-group]") as SVGGElement | null;
    const hitKey = hitWrapper?.dataset.studioGroup;
    const key = modalTool ? selectedGroupKey : hitKey;
    const wrapper = key ? svgHost.querySelector(`[data-studio-group="${CSS.escape(key)}"]`) as SVGGElement | null : null;
    if (!wrapper || !key) return;
    if (!modalTool) {
      const shapeTarget = (event.target as Element).closest("[data-studio-shape],[data-studio-shape-render]") as SVGElement | null;
      const shapeKey = shapeTarget?.dataset.studioShape ?? shapeTarget?.dataset.studioShapeRender ?? null;
      if (!selectGroup(key, shapeKey)) return;
    }
    if (activeTool === "shape") {
      status = activePose ? "Shape selected · drag a node to reshape this pose" : "REST is protected. Create a pose before reshaping artwork.";
      event.preventDefault();
      return;
    }
    if (!activePose) { status = "REST is protected. Create a pose before moving artwork."; return; }
    const rootSvg = svgHost.querySelector("svg");
    const inverse = rootSvg?.getScreenCTM()?.inverse();
    if (!inverse) return;
    const rootPoint = new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse);
    const sourcePivot = pivots[key] ?? { x: 0, y: 0 };
    const directMatrix = matrixFor(currentTransform(key)) as Matrix;
    const currentLocal = calculatedGroupMatrices()[key];
    const rigPrefix = multiplyMatrix(currentLocal, invertMatrix(directMatrix));
    const parentInverse = invertMatrix(wrapperParentMatrices[key] ?? [1, 0, 0, 1, 0, 0]);
    const rootToTool = multiplyMatrix(invertMatrix(rigPrefix), parentInverse);
    const startPoint = pointWithMatrix(rootToTool, rootPoint.x, rootPoint.y);
    const pivot = pointWithMatrix(directMatrix, sourcePivot.x, sourcePivot.y);
    drag = {
      pointerId: event.pointerId, key, startPoint, startTransform: { ...currentTransform(key) }, inverse, rootToTool, pivot,
      startAngle: Math.atan2(startPoint.y - pivot.y, startPoint.x - pivot.x),
      startDistance: Math.max(1, Math.hypot(startPoint.x - pivot.x, startPoint.y - pivot.y)),
      startDx: startPoint.x - pivot.x,
      startDy: startPoint.y - pivot.y,
      historyBefore: captureDocument(),
    };
    svgHost.setPointerCapture(event.pointerId); event.preventDefault();
  }
  function pointerMove(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rootPoint = new DOMPoint(event.clientX, event.clientY).matrixTransform(drag.inverse);
    const point = pointWithMatrix(drag.rootToTool, rootPoint.x, rootPoint.y);
    if (activeTool === "move") {
      updateTransform(drag.key, { ...drag.startTransform, x: drag.startTransform.x + point.x - drag.startPoint.x, y: drag.startTransform.y + point.y - drag.startPoint.y }, false, false);
    } else if (activeTool === "rotate") {
      const angle = Math.atan2(point.y - drag.pivot.y, point.x - drag.pivot.x);
      updateTransform(drag.key, { ...drag.startTransform, rotation: drag.startTransform.rotation + (angle - drag.startAngle) * 180 / Math.PI }, false, false);
    } else {
      const basis = Math.max(20, Math.min(viewBox[2], viewBox[3]) * 0.25);
      const factorX = 1 + (point.x - drag.startPoint.x) / basis;
      const factorY = 1 + (point.y - drag.startPoint.y) / basis;
      const pair = scalePair(factorX, factorY, drag.startTransform.scaleX, drag.startTransform.scaleY);
      updateTransform(drag.key, { ...drag.startTransform, scaleX: pair.x, scaleY: pair.y }, false, false);
    }
  }
  function pointerUp(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const before = drag.historyBefore;
    drag = null; commitHistory("Transform group", before); schedulePreview(); status = `${activePose?.name ?? "Pose"} updated`;
  }
  function shapePointerDown(event: PointerEvent) {
    if (event.button !== 0 || !shapeEditor || !activePose || !vectorOverlay) return;
    const handleElement = (event.target as Element).closest("[data-shape-handle]") as SVGElement | null;
    const handle = shapeEditor.handles.find((candidate) => candidate.id === handleElement?.dataset.shapeHandle);
    if (!handle) return;
    const nodeIndex = nodeIndexForHandle(shapeEditor.commands, handle);
    const nodeMode = activePose.shapeNodeModes?.[shapeEditor.shapeKey]?.[String(nodeIndex)] ?? inferredShapeNodeMode(shapeEditor.commands, nodeIndex);
    selectedShapeNodeIndex = nodeIndex;
    shapeDrag = { pointerId: event.pointerId, handle, nodeMode, historyBefore: captureDocument() };
    vectorOverlay.setPointerCapture(event.pointerId);
    event.stopPropagation();
    event.preventDefault();
  }
  function shapePointerMove(event: PointerEvent) {
    if (!shapeDrag || shapeDrag.pointerId !== event.pointerId || !shapeEditor || !vectorOverlay) return;
    const inverse = vectorOverlay.getScreenCTM()?.inverse();
    if (!inverse) return;
    const rootPoint = new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse);
    const localPoint = pointWithMatrix(shapeEditor.rootToLocal, rootPoint.x, rootPoint.y);
    const currentHandle = shapeEditor.handles.find((candidate) => candidate.id === shapeDrag?.handle.id) ?? shapeDrag.handle;
    updateShapeCommands(movePathHandle(shapeEditor.commands, currentHandle, localPoint.x, localPoint.y, shapeDrag.nodeMode));
    event.preventDefault();
  }
  function shapePointerUp(event: PointerEvent) {
    if (!shapeDrag || shapeDrag.pointerId !== event.pointerId) return;
    const before = shapeDrag.historyBefore;
    shapeDrag = null;
    commitHistory("Reshape vector", before);
    scheduleEditorOverlay();
    schedulePreview();
    status = `Vector volume · ${shapeVolumePercent.toFixed(1)}% of source`;
    event.preventDefault();
  }
  function nudgeSelectedBone(horizontalPixels: number, verticalPixels: number) {
    if (!selectedBone || (rigEditMode === "pose" && !activePose)) return;
    const world = boneWorlds[selectedBone.id];
    if (!world) return;
    const rootDelta = outputPixelDelta(
      viewBox,
      { width: outputWidth, height: outputHeight },
      resizeMode,
      { x: horizontalPixels, y: verticalPixels },
    );
    const parentMatrix = selectedBone.parentId ? boneWorlds[selectedBone.parentId]?.matrix : null;
    const parentInverse = parentMatrix ? invertMatrix(parentMatrix) : [1, 0, 0, 1, 0, 0] as Matrix;
    const localStart = pointWithMatrix(parentInverse, world.startX + rootDelta.x, world.startY + rootDelta.y);
    const localEnd = pointWithMatrix(parentInverse, world.endX + rootDelta.x, world.endY + rootDelta.y);
    const dx = localEnd.x - localStart.x;
    const dy = localEnd.y - localStart.y;
    const currentEffective = effectiveBoneTransform(selectedBone.id);
    const effective: BonePoseTransform = {
      x: localStart.x - selectedBone.x,
      y: localStart.y - selectedBone.y,
      rotation: Math.atan2(dy, dx) * 180 / Math.PI - selectedBone.restRotation,
      scaleX: Math.max(0.02, Math.hypot(dx, dy) / Math.max(1, selectedBone.length)),
      scaleY: currentEffective.scaleY,
    };
    const before = captureDocument();
    if (rigEditMode === "setup") {
      updateSetupBoneTransform(selectedBone.id, relativeBoneTransform(effective, currentBoneTransform(selectedBone.id)), false, false);
    } else {
      updateBonePose(selectedBone.id, relativeBoneTransform(effective, currentSetupBoneTransform(selectedBone.id)), false, false);
    }
    const pixelCount = Math.max(Math.abs(horizontalPixels), Math.abs(verticalPixels));
    commitHistory(`Nudge bone ${pixelCount} pixel${pixelCount === 1 ? "" : "s"}`, before);
    status = `${selectedBone.name} nudged ${pixelCount} output pixel${pixelCount === 1 ? "" : "s"}`;
  }
  function keyboardHandler(event: KeyboardEvent) {
    const shortcut = event.ctrlKey || event.metaKey;
    const shortcutKey = event.key.toLowerCase();
    if (shortcut && !event.altKey && shortcutKey === "s") {
      event.preventDefault(); void saveProject(event.shiftKey); return;
    }
    if (shortcut && !event.altKey && shortcutKey === "o") {
      event.preventDefault(); void openProject(); return;
    }
    if (shortcut && !event.altKey && shortcutKey === "z") {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
      return;
    }
    if (shortcut && !event.altKey && shortcutKey === "y") {
      event.preventDefault(); redo(); return;
    }
    if (event.key === "Escape" && isPlaying) {
      event.preventDefault(); stopPlayback(); status = onionSkin ? "Pose playback stopped · onion skin resumed" : "Pose playback stopped"; return;
    }
    if (event.key === "Escape" && modalTool) {
      event.preventDefault(); exitModalTransform(true); return;
    }
    if (event.key === "Escape") {
      event.preventDefault(); clearEditorSelection(); return;
    }
    if ((event.target as HTMLElement | null)?.matches("input,select,textarea")) return;
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !isPlaying) {
      event.preventDefault(); togglePlayback(); return;
    }
    const key = event.key.toLowerCase();
    if (key === "v") { selectEditorTool("move"); return; }
    if (key === "g") { event.preventDefault(); enterModalTransform("move"); return; }
    if (key === "r") { event.preventDefault(); enterModalTransform("rotate"); return; }
    if (key === "s") { event.preventDefault(); enterModalTransform("scale"); return; }
    if (key === "b") { selectEditorTool("shape"); return; }
    if (activeTool === "shape" && selectedShapeNodeIndex !== null && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault(); removeSelectedShapeNode(); return;
    }
    if (activeTool === "shape" && selectedShapeNodeIndex !== null && event.key === "Insert") {
      event.preventDefault(); addShapeNode(); return;
    }
    if (!event.key.startsWith("Arrow")) return;
    const amount = event.shiftKey ? 10 : 1;
    if (viewMode === "rig" && selectedBone) {
      if (event.key === "ArrowLeft") nudgeSelectedBone(-amount, 0);
      if (event.key === "ArrowRight") nudgeSelectedBone(amount, 0);
      if (event.key === "ArrowUp") nudgeSelectedBone(0, -amount);
      if (event.key === "ArrowDown") nudgeSelectedBone(0, amount);
      event.preventDefault(); return;
    }
    if (viewMode === "vector" && selectedGroupKey && activePose) {
      const transform = { ...currentTransform(selectedGroupKey) };
      if (event.key === "ArrowLeft") transform.x -= amount;
      if (event.key === "ArrowRight") transform.x += amount;
      if (event.key === "ArrowUp") transform.y -= amount;
      if (event.key === "ArrowDown") transform.y += amount;
      updateTransform(selectedGroupKey, transform); event.preventDefault(); return;
    }
    if (!selectedBoneId && !selectedGroupKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault(); stepPoseView(event.key === "ArrowLeft" ? -1 : 1);
    }
  }
  function clearPixelPrerenderCache() {
    pixelPrerenderGeneration += 1;
    pixelFrameCache.clear();
    pixelPrerenderPromise = null;
  }
  async function encodePreviewCanvas(canvas: HTMLCanvasElement): Promise<Uint8Array> {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Pixel frame encoding failed.")), "image/png");
    });
    return new Uint8Array(await blob.arrayBuffer());
  }
  async function renderPlaybackPixelFrame(svg: string, width: number, height: number): Promise<Uint8Array> {
    if (aiPixelFilter && isTauri()) return renderRefinedPixelPng(svg, width, height);
    return encodePreviewCanvas(await rasterizeSvg(svg, width, height, { antiAlias, resizeMode }));
  }
  async function prerenderPixelFrames() {
    if (pixelPrerenderPromise || !isPlaying || poses.length === 0) return;
    const generation = pixelPrerenderGeneration;
    const width = Math.max(1, Math.round(outputWidth));
    const height = Math.max(1, Math.round(outputHeight));
    // Serialize all frames before awaiting raster work. This keeps playback
    // from racing with temporary SVG host transforms during the first loop.
    const frameSvgs = poses.map((pose) => ({ id: pose.id, svg: serializePoseFrame(pose) }));
    restoreActivePoseHost();
    pixelPrerenderPromise = (async () => {
      for (const frame of frameSvgs) {
        if (!isPlaying || generation !== pixelPrerenderGeneration) return;
        const png = await renderPlaybackPixelFrame(frame.svg, width, height);
        if (!isPlaying || generation !== pixelPrerenderGeneration) return;
        pixelFrameCache.set(frame.id, png);
      }
      if (isPlaying && generation === pixelPrerenderGeneration) {
        status = `Playing ${poses.length} pose${poses.length === 1 ? "" : "s"} at ${playbackFps} FPS · pixel frames ready`;
      }
    })().catch((error) => {
      if (generation === pixelPrerenderGeneration) console.warn("Pixel playback prerender failed", error);
    }).finally(() => {
      if (generation === pixelPrerenderGeneration) pixelPrerenderPromise = null;
    });
    await pixelPrerenderPromise;
  }
  function schedulePreview(preservePlaybackCache = false) {
    if (!preservePlaybackCache) {
      clearPixelPrerenderCache();
      if (isPlaying) queueMicrotask(() => void prerenderPixelFrames());
    }
    previewRevision += 1;
    if (previewTimer) clearTimeout(previewTimer);
    // Native categorical supersampling is asynchronous, but collapsing rapid
    // slider changes still avoids rendering intermediate states nobody sees.
    const delay = preservePlaybackCache ? 0 : aiPixelFilter ? 180 : 90;
    previewTimer = setTimeout(() => {
      previewTimer = null;
      void refreshPreview();
    }, delay);
  }
  async function refreshPreview() {
    if (!svgHost || !previewCanvas || !sourceSvg) return;
    if (previewRunning) {
      previewQueued = true;
      return;
    }
    previewRunning = true;
    try {
      do {
        previewQueued = false;
        await refreshPreviewFrame(previewRevision);
      } while (previewQueued);
    } finally {
      previewRunning = false;
      aiPreviewBusy = false;
    }
  }
  async function renderRefinedPixelPng(svg: string, width: number, height: number): Promise<Uint8Array> {
    const refined = await invoke<number[]>("render_pixel_png", {
      svg,
      paletteSvg: sourceSvg,
      width,
      height,
      resizeMode,
      paletteSize: Math.round(aiPaletteSize),
      contourStrength: Math.round(pixelContourStrength),
      preserveDetails: Math.round(pixelDetailFloor),
      coverageThreshold: Math.round(pixelCoverageThreshold),
    });
    return new Uint8Array(refined);
  }
  async function refreshPreviewFrame(revision: number) {
    const width = Math.max(1, Math.round(outputWidth));
    const height = Math.max(1, Math.round(outputHeight));
    const cachedPlaybackFrame = isPlaying ? pixelFrameCache.get(activePoseId) : undefined;
    if (cachedPlaybackFrame) {
      await renderEncodedPixelPreview(cachedPlaybackFrame, previewCanvas, width, height);
      if (revision !== previewRevision) return;
      canvasBackend = `Playback cache · ${pixelFrameCache.size}/${poses.length} pixel frames`;
      return;
    }
    const svg = serializeForExport(svgHost);
    const useRasterizer = aiPixelFilter && isTauri();
    const paletteSize = Math.round(aiPaletteSize);
    const previewOptions = { antiAlias, resizeMode };
    let neighbors = onionSkin && !isPlaying ? wrappedPoseNeighbors(poses, activePoseId) : null;
    const onionGroupKeys = onionSkinBoneGroups();
    let previousSvg: string | null = null;
    let nextSvg: string | null = null;
    try {
      if (neighbors) {
        previousSvg = serializePoseFrame(neighbors.previous, onionGroupKeys);
        nextSvg = serializePoseFrame(neighbors.next, onionGroupKeys);
        restoreActivePoseHost();
      }
    } catch (error) {
      console.warn("Unable to prepare onion-skin frames", error);
      neighbors = null;
      previousSvg = null;
      nextSvg = null;
      restoreActivePoseHost();
    }
    try {
      if (useRasterizer) {
        aiPreviewBusy = true;
        canvasBackend = `Pixel rasterizer · resolving ${paletteSize} colors`;
        const refined = await renderRefinedPixelPng(svg, width, height);
        if (revision !== previewRevision) return;
        await renderEncodedPixelPreview(refined, previewCanvas, width, height);
        if (revision !== previewRevision) return;
        if (previousSvg && nextSvg) {
          const [previousPng, nextPng] = await Promise.all([
            renderRefinedPixelPng(previousSvg, width, height),
            renderRefinedPixelPng(nextSvg, width, height),
          ]);
          if (revision !== previewRevision) return;
          const [previousFrame, nextFrame] = await Promise.all([
            encodedPngToCanvas(previousPng, width, height),
            encodedPngToCanvas(nextPng, width, height),
          ]);
          if (revision !== previewRevision) return;
          overlayOnionSkins(previewCanvas, width, height, previousFrame, nextFrame);
        }
        canvasBackend = `Pixel rasterizer · ${paletteSize} locked colors${neighbors ? " · Onion skin" : ""}`;
        aiPreviewBusy = false;
        return;
      }
      aiPreviewBusy = false;
      const backend = await renderPixelPreview(svg, width, height, previewCanvas, previewOptions);
      if (revision !== previewRevision) return;
      if (previousSvg && nextSvg) {
        const [previousFrame, nextFrame] = await Promise.all([
          rasterizeSvg(previousSvg, width, height, previewOptions),
          rasterizeSvg(nextSvg, width, height, previewOptions),
        ]);
        if (revision !== previewRevision) return;
        overlayOnionSkins(previewCanvas, width, height, previousFrame, nextFrame);
      }
      canvasBackend = `${backend === "canvaskit" ? "CanvasKit · Skia/WASM" : "Canvas 2D fallback"}${neighbors ? " · Onion skin" : ""}`;
    } catch (error) {
      console.error(error);
      if (revision !== previewRevision) return;
      aiPreviewBusy = false;
      canvasBackend = useRasterizer ? "Pixel rasterizer unavailable" : "Preview unavailable";
      status = error instanceof Error ? error.message : String(error);
    }
  }
  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => localStorage.setItem("asset-studio:last-session", JSON.stringify({ sourceSvg, fileName, poses, bones, setupBoneTransforms, rigTransformModel: 2, activePoseId, outputWidth, outputHeight, antiAlias, resizeMode, rigEditMode, preferredRigEditMode, aiPixelFilter, aiPaletteSize, pixelContourStrength, pixelDetailFloor, pixelCoverageThreshold, primaryView: viewMode, pixelVisible, playbackFps, onionSkin, onionSkinScope, onionSkinRadius, zoom, canvasPan } satisfies Session)), 250);
  }
  async function exportPngInBrowser(svg: string, name: string) {
    try {
      const canvas = await rasterizeSvg(svg, outputWidth, outputHeight, { antiAlias, resizeMode });
      const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG export failed.")), "image/png"));
      const link = document.createElement("a"); link.href = URL.createObjectURL(png); link.download = name; link.click(); URL.revokeObjectURL(link.href);
    } catch (error) { throw error; }
  }
  async function exportPng() {
    if (!sourceSvg) return;
    const svg = serializePoseFrame(activePose), base = fileName.replace(/\.svg$/i, "");
    applyAllTransforms();
    const poseName = (activePose?.name ?? "rest").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
    const defaultName = `${base}-${poseName}-${outputWidth}x${outputHeight}.png`;
    try {
      if (isTauri()) {
        const path = await save({ defaultPath: defaultName, filters: [{ name: "Portable Network Graphics", extensions: ["png"] }] });
        if (!path) return;
        await invoke("export_png", { svg, paletteSvg: sourceSvg, path, width: Math.round(outputWidth), height: Math.round(outputHeight), antiAlias: Math.round(antiAlias), resizeMode, pixelArt: aiPixelFilter, paletteSize: Math.round(aiPaletteSize), contourStrength: Math.round(pixelContourStrength), preserveDetails: Math.round(pixelDetailFloor), coverageThreshold: Math.round(pixelCoverageThreshold) });
        status = `Exported ${path.split(/[\\/]/).pop()}`;
      } else { await exportPngInBrowser(svg, defaultName); status = `Exported ${defaultName}`; }
    } catch (error) { status = error instanceof Error ? error.message : String(error); }
  }
  function applyOnionVectorFilter(groupKeys?: ReadonlySet<string>) {
    for (const shape of Array.from(svgHost.querySelectorAll<SVGGraphicsElement>("[data-studio-shape-group]"))) {
      const shouldHide = groupKeys !== undefined && !groupKeys.has(shape.dataset.studioShapeGroup ?? "");
      if (shouldHide) {
        if (!shape.hasAttribute("data-studio-onion-display")) {
          shape.setAttribute("data-studio-onion-display", shape.style.display);
        }
        shape.style.display = "none";
      } else if (shape.hasAttribute("data-studio-onion-display")) {
        shape.style.display = shape.getAttribute("data-studio-onion-display") ?? "";
        shape.removeAttribute("data-studio-onion-display");
      }
    }
  }
  function applyPoseFrameToHost(pose: Pose | null, deformFromRig = true, matrixOverrides?: Record<string, Matrix>, onionGroupKeys?: ReadonlySet<string>) {
    const matrices = matrixOverrides ?? calculatedGroupMatricesFor(pose);
    for (const group of groups) {
      setWrapperMatrix(svgHost, group.key, matrices[group.key]);
      setWrapperVisibility(svgHost, group.key, groupIsVisible(group.key, pose));
    }
    applyPoseShapePaths(pose, deformFromRig);
    applyOnionVectorFilter(onionGroupKeys);
  }
  function restoreActivePoseHost() {
    const calculated = calculatedGroupMatrices();
    const freezeRig = viewMode === "rig" && rigEditMode === "setup" && !isPlaying;
    const matrices = Object.fromEntries(groups.map((group) => [
      group.key,
      freezeRig && setupFrozenMatrices[group.key] ? setupFrozenMatrices[group.key] : calculated[group.key],
    ]));
    applyPoseFrameToHost(activePose, rigEditMode === "pose" || isPlaying, matrices);
    selectWrapper(svgHost, selectedGroupKey);
    highlightBoneWrapper(svgHost, selectedBone?.groupKey ?? null);
  }
  function serializePoseFrame(pose: Pose | null, onionGroupKeys?: ReadonlySet<string>): string {
    applyPoseFrameToHost(pose, true, undefined, onionGroupKeys);
    return serializeForExport(svgHost);
  }
  function serializeAllFrames(): string[] {
    const frames = poses.map((pose) => serializePoseFrame(pose));
    applyAllTransforms();
    return frames;
  }
  async function exportTilesetInBrowser(svgs: string[], name: string) {
    const frameWidth = Math.max(1, Math.round(outputWidth));
    const frameHeight = Math.max(1, Math.round(outputHeight));
    const sheet = document.createElement("canvas");
    sheet.width = frameWidth * svgs.length; sheet.height = frameHeight;
    const context = sheet.getContext("2d");
    if (!context) throw new Error("Unable to create the tileset canvas.");
    context.imageSmoothingEnabled = false;
    for (let index = 0; index < svgs.length; index += 1) {
      const frame = await rasterizeSvg(svgs[index], frameWidth, frameHeight, { antiAlias, resizeMode });
      context.drawImage(frame, index * frameWidth, 0);
    }
    const png = await new Promise<Blob>((resolve, reject) => sheet.toBlob((value) => value ? resolve(value) : reject(new Error("Tileset export failed.")), "image/png"));
    const link = document.createElement("a"); link.href = URL.createObjectURL(png); link.download = name; link.click(); URL.revokeObjectURL(link.href);
  }
  async function exportTileset() {
    if (!sourceSvg || poses.length === 0) { status = "Create at least one pose to export a tileset."; return; }
    const svgs = serializeAllFrames();
    const base = fileName.replace(/\.svg$/i, "");
    const defaultName = `${base}-tileset-${svgs.length}f-${outputWidth}x${outputHeight}.png`;
    try {
      if (isTauri()) {
        const path = await save({ defaultPath: defaultName, filters: [{ name: "Horizontal PNG Tileset", extensions: ["png"] }] });
        if (!path) return;
        await invoke("export_tileset", { svgs, paletteSvg: sourceSvg, path, width: Math.round(outputWidth), height: Math.round(outputHeight), antiAlias: Math.round(antiAlias), resizeMode, pixelArt: aiPixelFilter, paletteSize: Math.round(aiPaletteSize), contourStrength: Math.round(pixelContourStrength), preserveDetails: Math.round(pixelDetailFloor), coverageThreshold: Math.round(pixelCoverageThreshold) });
        status = `Exported ${svgs.length}-frame tileset`;
      } else {
        await exportTilesetInBrowser(svgs, defaultName);
        status = `Exported ${defaultName}${aiPixelFilter ? " without the desktop pixel-art rasterizer" : ""}`;
      }
    } catch (error) { status = error instanceof Error ? error.message : String(error); }
  }
</script>

<svelte:window onkeydown={keyboardHandler} />
<main class="studio-shell">
  <input bind:this={fileInput} class="hidden-input" type="file" accept="image/svg+xml,.svg" onchange={receiveFile} />
  <input bind:this={projectFileInput} class="hidden-input" type="file" accept=".astd,application/json" onchange={receiveProjectFile} />
  <header class="topbar">
    <div class="brand-block"><span class="brand-mark">AS</span><div><strong>ASSET/STUDIO</strong><small>VECTOR POSE LAB</small></div></div>
    <div class="document-pill" title={`${projectName} · ${fileName}`}><span class:live={Boolean(sourceSvg)} class:dirty></span><div><small>{projectPath ? `${projectName}${dirty ? " · MODIFIED" : " · SAVED"}` : `UNSAVED .ASTD${dirty ? " · MODIFIED" : " · RECOVERED"}`}</small><strong>{fileName}</strong></div></div>
    <div class="top-actions"><div class="history-actions" aria-label="Edit history"><button disabled={!undoStack.length} onclick={undo} title="Undo (Ctrl+Z)">↶<small>CTRL Z</small></button><button disabled={!redoStack.length} onclick={redo} title="Redo (Ctrl+Y)">↷<small>CTRL Y</small></button></div><div class="file-actions" aria-label="Project files"><button onclick={newProject} title="Create a new project from an SVG"><span>◇</span><small>NEW</small></button><button onclick={openSvg} title={sourceSvg ? "Replace this project's SVG and relink its rig" : "Import SVG into a new project"}><span>↗</span><small>{sourceSvg ? "SWAP" : "SVG"}</small></button><button onclick={openProject} title="Open .astd project (Ctrl+O)"><span>⌁</span><small>OPEN</small></button><button disabled={!sourceSvg} onclick={() => saveProject(false)} title="Save .astd project (Ctrl+S)"><span>▣</span><small>SAVE</small></button><button disabled={!sourceSvg} onclick={() => saveProject(true)} title="Save project as (Ctrl+Shift+S)"><span>＋</span><small>AS</small></button></div><button class="button primary" disabled={!sourceSvg} onclick={exportPng}><span>↓</span> Export PNG</button></div>
  </header>

  <section class="workspace">
    <aside class="panel layers-panel">
      <div class="panel-heading"><div><span class="eyebrow">DOCUMENT</span><h2>{leftMode === "groups" ? "SVG Groups" : "Bone Rig"}</h2></div><span class="count">{leftMode === "groups" ? groups.length : bones.length}</span></div>
      <div class="panel-tabs"><button class:active={leftMode === "groups"} onclick={() => (leftMode = "groups")}>GROUPS</button><button class:active={leftMode === "rig"} onclick={() => (leftMode = "rig")}>RIG</button></div>
      {#if leftMode === "groups"}
        {#if groups.length}
          <div class="group-list">
            {#each groups as group, index}
              {@const visible = groupIsVisible(group.key)}
              {@const boneBound = selectedBone?.groupKey === group.key}
              <div class:selected={selectedGroupKey === group.key} class:bound={boneBound} class:layer-hidden={!visible} class="layer-row" style={`--depth:${group.depth}`}>
                <button class="layer-select" onclick={() => selectGroup(group.key)}>
                  <span class="disclosure">{group.parentKey ? "└" : "◆"}</span><span class="group-icon">G</span>
                  <span class="group-copy"><strong>{group.label}</strong><small>{group.sourceId ? `#${group.sourceId}` : `GROUP ${String(index + 1).padStart(2, "0")}`}{#if boneBound}<em> · BONE LINK</em>{/if}</small></span>
                </button>
                <button class:off={!visible} class="visibility-toggle" aria-label={`${visible ? "Hide" : "Show"} ${group.label} in this pose`} aria-pressed={!visible} title={activePose ? `${visible ? "Hide" : "Show"} in ${activePose.name}` : "Rest visibility is locked"} onclick={(event) => toggleGroupVisibility(group, event)}><span></span></button>
              </div>
            {/each}
          </div>
        {:else}
          <div class="empty-panel"><span class="empty-glyph">◇</span><strong>No vector loaded</strong><p>Open an SVG with groups to begin building poses.</p><button class="text-button" onclick={openSvg}>Choose SVG →</button></div>
        {/if}
      {:else}
        <div class="rig-tools"><button disabled={!sourceSvg || rigEditMode !== "setup"} onclick={addBone}>＋ ADD {selectedBone ? "CHILD" : "ROOT"} BONE</button><small>{rigEditMode === "setup" ? (selectedBone ? "CHAIN: 50% COVER → NEXT UNRIGGED SHAPE" : selectedGroup ? `AUTO-BIND: ${selectedGroup.label}` : "SELECT A GROUP TO AUTO-BIND") : "SWITCH TO SETUP TO EDIT THE RIG"}</small></div>
        {#if bones.length}
          <div class="group-list bone-list">
            {#each bones as bone}
              <button class:selected={selectedBoneId === bone.id} class="group-row" style={`--depth:${boneDepth(bone, bones)}`} onclick={() => selectBone(bone.id)}>
                <span class="disclosure">{bone.parentId ? "└" : "◆"}</span><span class="group-icon bone-icon">B</span>
                <span class="group-copy"><strong>{bone.name}</strong><small>{bone.groupKey ? groups.find((group) => group.key === bone.groupKey)?.label : "GUIDE ONLY"}</small></span>
              </button>
            {/each}
          </div>
        {:else}<div class="empty-panel compact"><span class="empty-glyph">⌁</span><strong>No bones yet</strong><p>Select an SVG group, then add a root bone. Select that bone to extend a chain.</p></div>{/if}
      {/if}
      {#if warnings.length}<div class="warning-stack"><span>IMPORT NOTES</span>{#each warnings.slice(0, 3) as warning}<p>{warning}</p>{/each}</div>{/if}
    </aside>

    <section class="stage-column">
      <div class="stage-toolbar">
        <div class="segmented"><button class:active={viewMode === "vector"} onclick={() => togglePrimaryView("vector")}>VECTOR</button><button class:active={viewMode === "rig"} onclick={() => togglePrimaryView("rig")}>RIG</button><button class:active={pixelVisible} onclick={togglePixelView}>PIXEL</button></div>
        <div class="stage-meta"><span>{activePose?.name ?? "REST / SOURCE"}</span><i></i><span>{pixelVisible ? `${outputWidth} × ${outputHeight} PX` : `${Math.round(zoom * 100)}%`}</span>{#if pixelVisible && viewMode}<em>SPLIT</em>{/if}</div>
        <div class="zoom-controls"><button disabled={!viewMode} title="Zoom out" onclick={() => setCanvasZoom(zoom - 0.1)}>−</button><span>{Math.round(zoom * 100)}%</span><button disabled={!viewMode} title="Zoom in" onclick={() => setCanvasZoom(zoom + 0.1)}>+</button></div>
      </div>
      <div class="tool-optionsbar">
        <div class:modal={Boolean(modalTool)} class="active-tool-readout"><span>{viewMode === null ? "▦" : modalTool === "move" ? "✥" : modalTool === "rotate" ? "↻" : modalTool === "scale" ? "⌗" : viewMode === "rig" ? "⌘" : activeTool === "move" ? "✥" : activeTool === "rotate" ? "↻" : activeTool === "shape" ? "◇" : "⌗"}</span><strong>{viewMode === null ? "PIXEL OUTPUT" : modalTool ? `${modalTool.toUpperCase()} LOCK` : viewMode === "rig" ? "SMART BONE" : activeTool === "shape" ? "NODE SHAPE" : activeTool.toUpperCase()}</strong><small>{viewMode === null ? "SOLO PREVIEW" : modalTool ? "DRAG ANYWHERE · ESC EXIT" : viewMode === "rig" ? "POSITION-SENSITIVE" : activeTool === "move" ? "DRAG SELECTION" : activeTool === "rotate" ? "DRAG AROUND PIVOT" : activeTool === "shape" ? "BÉZIER · POSE LOCAL" : "DRAG TO RESIZE"}</small></div>
        {#if modalTool}<div class="modal-lock-legend"><b>SELECTION LOCKED</b><span>{viewMode === "rig" ? selectedBone?.name : selectedGroup?.label}</span><kbd>ESC</kbd></div>{:else if viewMode === "rig"}<div class="smart-gesture-legend"><span><i class="move-mark">✥</i> MIDDLE · MOVE</span><span><i class="rotate-mark">↻</i> SMALL END · ROTATE</span><span><i class="scale-mark">↔</i> END RING · RESIZE</span></div>{:else if viewMode === null}<div class="tool-hint">CLICK VECTOR OR RIG TO DOCK IT BESIDE PIXEL</div>{:else if activeTool === "shape"}
          <div class="node-edit-actions"><button disabled={selectedShapeNodeIndex === null} title="Insert a node halfway along the next segment (Insert)" onclick={addShapeNode}><b>＋</b> NODE</button><button disabled={selectedShapeNodeIndex === null} title="Remove selected node (Delete)" onclick={removeSelectedShapeNode}><b>−</b> NODE</button><i></i><span>CONVERT</span><button class:active={selectedShapeNodeMode === "sharp"} disabled={selectedShapeNodeIndex === null} title="Corner: remove both pullers" onclick={() => setSelectedShapeNodeMode("sharp")}><b class="corner-node">⌃</b></button><button class:active={selectedShapeNodeMode === "smooth"} disabled={selectedShapeNodeIndex === null} title="Smooth: two independent pullers" onclick={() => setSelectedShapeNodeMode("smooth")}><b class="smooth-node">⌒</b></button><button class:active={selectedShapeNodeMode === "smart"} disabled={selectedShapeNodeIndex === null} title="Smart: two linked pullers" onclick={() => setSelectedShapeNodeMode("smart")}><b class="smart-node">◠</b></button></div>
          <div class:stable={Math.abs(shapeVolumePercent - 100) <= 2} class:caution={Math.abs(shapeVolumePercent - 100) > 2 && Math.abs(shapeVolumePercent - 100) <= 10} class="shape-volume-readout"><span>VOLUME</span><strong>{shapeEditor ? `${shapeVolumePercent.toFixed(1)}%` : "—"}</strong><small>VS SOURCE</small></div>
        {:else if activeTool === "scale"}<div class="transform-options"><button class:active={lockRatio} onclick={() => { lockRatio = !lockRatio; if (lockRatio) preserveArea = false; }}><span>⛓</span> LOCK RATIO</button><button class:active={preserveArea} onclick={() => { preserveArea = !preserveArea; if (preserveArea) lockRatio = false; }}><span>◫</span> KEEP AREA</button></div>{:else}<div class="tool-hint">{activeTool === "move" ? "SHIFT + ARROWS · 10 UNITS" : "PIVOT-CENTERED · NON-DESTRUCTIVE"}</div>{/if}
        <div class="options-spacer"></div>
        {#if viewMode === "rig"}<div class="rig-mode-switch"><span>RIG MODE</span><button class:active={rigEditMode === "setup"} onclick={() => setRigEditMode("setup")}><b>01</b> SETUP</button><button class:active={rigEditMode === "pose"} disabled={!activePose} onclick={() => setRigEditMode("pose")}><b>02</b> POSE</button></div>{/if}
      </div>
      <div class="stage" class:split-view={pixelVisible && viewMode !== null} class:pixel-only={pixelVisible && viewMode === null}>
        <div class="stage-grid"></div><div class="axis horizontal"></div><div class="axis vertical"></div>
        <div bind:this={primaryViewport} class="viewport-pane primary-viewport" class:pane-suppressed={viewMode === null} class:panning={Boolean(panDrag)} class:mode-cursor={Boolean(canvasTransformMode)} class:modal-transform={Boolean(modalTool)} class:modal-move={modalTool === "move"} class:modal-rotate={modalTool === "rotate"} class:modal-scale={modalTool === "scale"} style={`--canvas-tool-cursor:${canvasToolCursor}`} role="application" aria-label="Canvas navigation surface" onwheel={canvasWheel} onpointerdown={viewportPointerDown} onpointermove={viewportPointerMove} onpointerup={viewportPointerUp} onpointercancel={viewportPointerUp} onauxclick={(event) => event.preventDefault()}>
          <div class="pane-label"><span>{viewMode === "rig" ? "RIG" : "VECTOR"}</span><small>LIVE WORKSPACE</small></div>
          <div class="canvas-nav-hint"><span>↕</span> SCROLL · ZOOM <i></i><span>●</span> MIDDLE DRAG · PAN <i></i><span>G R S</span> MODAL TRANSFORM {#if viewMode === "rig"}<i></i><span>⌨</span> ARROWS · 1 PX{/if}</div>
          <nav class="tool-rail" aria-label="Transform tools">
            {#if viewMode === "rig"}<button class:active={!modalTool} class="smart-tool" title="Position-sensitive bone transform"><span>⌘</span><small>AUTO</small></button><button class:active={modalTool === "move"} onclick={() => enterModalTransform("move")} title="Lock selected bone to move mode (G)"><span>✥</span><small>G</small></button><button class:active={modalTool === "rotate"} onclick={() => enterModalTransform("rotate")} title="Lock selected bone to rotate mode (R)"><span>↻</span><small>R</small></button><button class:active={modalTool === "scale"} onclick={() => enterModalTransform("scale")} title="Lock selected bone to scale mode (S)"><span>⌗</span><small>S</small></button>{:else}<button class:active={activeTool === "move"} onclick={() => selectEditorTool("move")} title="Move tool (G for modal lock, V for persistent)"><span>✥</span><small>G</small></button>
            <button class:active={activeTool === "rotate"} onclick={() => selectEditorTool("rotate")} title="Rotate tool (R)"><span>↻</span><small>R</small></button>
            <button class:active={activeTool === "scale"} onclick={() => selectEditorTool("scale")} title="Resize tool (S)"><span>⌗</span><small>S</small></button>
            <button class:active={activeTool === "shape"} onclick={() => selectEditorTool("shape")} title="Non-destructive node shape tool (B)"><span>◇</span><small>B</small></button>{/if}
            <i></i><div class="tool-rail-mode">{viewMode === "rig" ? (rigEditMode === "setup" ? "SET" : "POSE") : "SVG"}</div>
          </nav>
          {#if modalTool}<div class={`modal-tool-banner ${modalTool}`}><kbd>{modalTool === "move" ? "G" : modalTool === "rotate" ? "R" : "S"}</kbd><strong>{modalTool.toUpperCase()}</strong><span>{viewMode === "rig" ? selectedBone?.name : selectedGroup?.label}</span><small>DRAG SCENE · ESC TO EXIT</small></div>{/if}
          <div class={`artboard-wrap tool-${activeTool}`} style={`--zoom:${zoom};--pan-x:${canvasPan.x}px;--pan-y:${canvasPan.y}px;--art-ratio:${viewBox[2] / viewBox[3]}`} class:rig-mode={viewMode === "rig"} class:modal-transform={Boolean(modalTool)} class:modal-move={modalTool === "move"} class:modal-rotate={modalTool === "rotate"} class:modal-scale={modalTool === "scale"}>
            <div class="artboard-shadow"></div>
            <div bind:this={svgHost} class="svg-host" role="application" aria-label="SVG pose viewport" onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={pointerUp}></div>
            {#if viewMode}
              <svg bind:this={vectorOverlay} class:node-editing={viewMode === "vector" && activeTool === "shape"} class="selection-overlay" viewBox={viewBox.join(" ")} preserveAspectRatio="xMidYMid meet" shape-rendering="geometricPrecision" role="application" aria-label="Vector selection geometry" onpointerdown={shapePointerDown} onpointermove={shapePointerMove} onpointerup={shapePointerUp} onpointercancel={shapePointerUp}>
                {#if selectionOverlay}
                  <g transform={selectionOverlay.matrix} class:bone-bound-overlay={selectionOverlay.kind === "bone"} class="selection-bounds">
                    <rect class="selection-bounds-wash" x={selectionOverlay.x} y={selectionOverlay.y} width={selectionOverlay.width} height={selectionOverlay.height}></rect>
                    <rect class="selection-bounds-line" x={selectionOverlay.x} y={selectionOverlay.y} width={selectionOverlay.width} height={selectionOverlay.height}></rect>
                    {#if selectionOverlay.kind === "selection"}
                      {#each [[selectionOverlay.x, selectionOverlay.y], [selectionOverlay.x + selectionOverlay.width, selectionOverlay.y], [selectionOverlay.x + selectionOverlay.width, selectionOverlay.y + selectionOverlay.height], [selectionOverlay.x, selectionOverlay.y + selectionOverlay.height]] as corner}
                        <rect class="selection-corner" x={corner[0]} y={corner[1]} width="7" height="7" transform={`translate(-3.5 -3.5)`}></rect>
                      {/each}
                    {/if}
                  </g>
                {/if}
                {#if viewMode === "vector" && activeTool === "shape" && shapeEditor}
                  {@const editor = shapeEditor}
                  <g transform={editor.matrix} class="node-shape">
                    <path class="node-shape-outline" d={editor.d}></path>
                    {#each editor.guides.filter((guide) => selectedShapeNodeMode !== "sharp" && guide.nodeIndex === selectedShapeNodeIndex) as guide}<line class="node-guide" x1={guide.x1} y1={guide.y1} x2={guide.x2} y2={guide.y2}></line>{/each}
                    {#each editor.handles.filter((handle) => handle.kind === "anchor" || (selectedShapeNodeMode !== "sharp" && nodeIndexForHandle(editor.commands, handle) === selectedShapeNodeIndex)) as handle}
                      {#if handle.kind === "control"}<circle class="node-handle control" data-shape-handle={handle.id} cx={handle.x} cy={handle.y} r="3.5"></circle>{:else}<rect class:selected={handle.commandIndex === selectedShapeNodeIndex} class="node-handle anchor" data-shape-handle={handle.id} x={handle.x - 4} y={handle.y - 4} width="8" height="8"></rect>{/if}
                    {/each}
                  </g>
                {/if}
              </svg>
            {/if}
            {#if viewMode === "rig"}
              <svg bind:this={rigSvg} class="rig-overlay" viewBox={viewBox.join(" ")} preserveAspectRatio="xMidYMid meet" role="application" aria-label="Bone rig overlay" onpointerdown={boneOverlayPointerDown} onpointermove={bonePointerMove} onpointerup={bonePointerUp} onpointercancel={bonePointerUp}>
                {#each renderedBones as bone}
                  {@const world = boneWorlds[bone.id]}
                  {@const handleRadius = Math.max(3, Math.min(viewBox[2], viewBox[3]) * 0.009)}
                  {@const parentLinked = Boolean(bone.parentId)}
                  {#if world}<g class="bone-shape" class:selected={selectedBoneId === bone.id} aria-label={bone.name}>
                    <line class="bone-hit bone-move-hit" data-bone-id={bone.id} data-bone-gesture="move" style={`cursor:${moveCursor}`} x1={world.startX} y1={world.startY} x2={world.endX} y2={world.endY}></line>
                    {#if !parentLinked}<circle class="bone-orbit-hit" data-bone-id={bone.id} data-bone-gesture="rotate-start" style={`cursor:${rotateCursor}`} cx={world.startX} cy={world.startY} r={handleRadius * 3.1}></circle>{/if}
                    <circle class="bone-orbit-hit" data-bone-id={bone.id} data-bone-gesture="rotate-end" style={`cursor:${rotateCursor}`} cx={world.endX} cy={world.endY} r={handleRadius * 3.1}></circle>
                    {#if !parentLinked}<circle class="bone-scale-hit" data-bone-id={bone.id} data-bone-gesture="scale-start" style={`cursor:${resizeCursor(world.angle)}`} cx={world.startX} cy={world.startY} r={handleRadius * 1.85}></circle>{/if}
                    <circle class="bone-scale-hit" data-bone-id={bone.id} data-bone-gesture="scale-end" style={`cursor:${resizeCursor(world.angle)}`} cx={world.endX} cy={world.endY} r={handleRadius * 1.85}></circle>
                    {#if !parentLinked}<circle class="bone-end-hit" data-bone-id={bone.id} data-bone-gesture="rotate-start" style={`cursor:${rotateCursor}`} cx={world.startX} cy={world.startY} r={handleRadius}></circle>{/if}
                    <circle class="bone-end-hit" data-bone-id={bone.id} data-bone-gesture="rotate-end" style={`cursor:${rotateCursor}`} cx={world.endX} cy={world.endY} r={handleRadius}></circle>
                    <line class="bone-body" x1={world.startX} y1={world.startY} x2={world.endX} y2={world.endY}></line>
                    <circle class="bone-joint" class:linked={parentLinked} cx={world.startX} cy={world.startY} r={handleRadius * (parentLinked ? 1.4 : 1)}></circle>
                    <circle class="bone-tip" cx={world.endX} cy={world.endY} r={handleRadius * .72}></circle>
                    {#if boneDrag?.boneId === bone.id && (boneDrag.gesture === "rotate-end" || boneDrag.gesture === "scale-end")}<circle class="pivot-lock" cx={world.startX} cy={world.startY} r={handleRadius * 1.55}></circle>{/if}
                    {#if boneDrag?.boneId === bone.id && (boneDrag.gesture === "rotate-start" || boneDrag.gesture === "scale-start")}<circle class="pivot-lock" cx={world.endX} cy={world.endY} r={handleRadius * 1.55}></circle>{/if}
                  </g>{/if}
                {/each}
              </svg>
            {/if}
          </div>
        </div>
        <div class="viewport-pane pixel-viewport" class:pane-suppressed={!pixelVisible}>
          <div class="pane-label pixel-label"><span>PIXEL</span><small>{aiPreviewBusy ? "RASTERIZER · RESOLVING…" : aiPixelFilter ? `LOCKED · ${aiPaletteSize}C` : "EXACT PREVIEW"}</small></div>
          <div class="pixel-preview-stack">
            <div class="pixel-preview" style={`aspect-ratio:${outputWidth}/${outputHeight}`}><canvas bind:this={previewCanvas} aria-label="Pixel-art preview"></canvas></div>
            <div class:processing={aiPreviewBusy} class="pixel-badge">{aiPreviewBusy ? "RESOLVING PIXELS…" : aiPixelFilter ? `CATEGORICAL ${aiPaletteSize}C · COVER ${pixelCoverageThreshold}%` : antiAlias === 0 ? "HARD ALPHA" : `EDGE AA ${antiAlias}%`} · {resizeMode === "contain" ? "FIT CENTER" : "STRETCH"}</div>
          </div>
        </div>
        {#if !sourceSvg}<button class="drop-target" onclick={openSvg}><span class="drop-icon">＋</span><strong>LOAD YOUR VECTOR</strong><p>SVG groups become poseable layers.</p><small>OPEN .SVG</small></button>{/if}
      </div>
      <div class="statusbar"><span class="status-light"></span><span>{status}</span><span class="status-spacer"></span><span>{dirty ? "PROJECT MODIFIED · CTRL S" : projectPath ? "PROJECT SAVED" : "LOCAL RECOVERY ON"}</span><span class="separator">/</span><span>{canvasBackend}</span><span class="separator">/</span><span>{wasmReady ? "RUST CORE ONLINE" : "CORE FALLBACK"}</span></div>
    </section>

    <aside class="panel inspector-panel">
      <div class="panel-heading"><div><span class="eyebrow">SELECTION</span><h2>{viewMode === "rig" ? "Bone" : "Transform"}</h2></div>{#if viewMode === "rig"}<button class="reset rest-reset" disabled={!selectedBone || (rigEditMode === "pose" && !activePose)} title="Restore the selected bone to its default Rest transform" onclick={resetSelectedBoneToRest}><span>↶</span> RESET TO REST</button>{:else}<button class="reset rest-reset" disabled={!canEdit || !selectedGroupKey} title="Clear this group's pose transform, visibility, and shape overrides" onclick={resetSelectedGroupToRest}><span>↶</span> RESET TO REST</button>{/if}</div>
      {#if viewMode === "rig" && selectedBone}
        <div class="selection-card"><span class="selection-chip bone-chip">B</span><div><small>ACTIVE BONE · {rigEditMode === "setup" ? "SETUP" : "POSE"}</small><strong>{selectedBone.name}</strong></div></div>
        <div class:follow={rigEditMode === "pose"} class="rig-behavior-note"><span>{rigEditMode === "setup" ? "01" : "02"}</span><div><strong>{rigEditMode === "setup" ? "Artwork frozen · guides live" : "Artwork follows the same guides"}</strong><small>{rigEditMode === "setup" ? "Arrange the guide placement freely. Switching to Pose keeps every bone exactly where you put it." : "The guide does not jump when modes change; bound groups now follow its current placement."}</small></div></div>
        <div class="control-section" class:disabled={rigEditMode !== "setup"}><div class="section-label"><span>IDENTITY</span><small>RIG DATA</small></div><label class="wide-control text-control"><span>N</span><input disabled={rigEditMode !== "setup"} value={selectedBone.name} onchange={changeBoneName} /></label></div>
        <div class="control-section" class:disabled={rigEditMode !== "setup"}><div class="section-label"><span>HIERARCHY</span><small>PARENT → CHILD</small></div><label class="select-control"><span>P</span><select disabled={rigEditMode !== "setup"} value={selectedBone.parentId ?? ""} onchange={changeBoneParent}><option value="">ROOT</option>{#each bones.filter((bone) => bone.id !== selectedBone.id && !wouldCreateCycle(selectedBone.id, bone.id, bones)) as bone}<option value={bone.id}>{bone.name}</option>{/each}</select></label><label class="select-control"><span>G</span><select disabled={rigEditMode !== "setup"} value={selectedBone.groupKey ?? ""} onchange={changeBoneBinding}><option value="">GUIDE ONLY</option>{#each groups as group}<option value={group.key}>{group.label}</option>{/each}</select></label></div>
        <div class="control-section" class:disabled={rigEditMode !== "setup"}>
          <div class="section-label"><span>BASE BONE</span><small>GLOBAL RIG</small></div>
          <div class="control-grid"><label><span>X</span><input disabled={rigEditMode !== "setup"} type="number" step="1" value={selectedBone.x.toFixed(2)} oninput={(event) => changeBoneNumber("x", event)} /></label><label><span>Y</span><input disabled={rigEditMode !== "setup"} type="number" step="1" value={selectedBone.y.toFixed(2)} oninput={(event) => changeBoneNumber("y", event)} /></label></div>
          <div class="control-grid second-row"><label><span>L</span><input disabled={rigEditMode !== "setup"} type="number" min="1" step="1" value={selectedBone.length.toFixed(2)} oninput={(event) => changeBoneNumber("length", event)} /></label><label><span>R</span><input disabled={rigEditMode !== "setup"} type="number" step="1" value={selectedBone.restRotation.toFixed(2)} oninput={(event) => changeBoneNumber("restRotation", event)} /></label></div>
          <button class="bone-fit-action" disabled={rigEditMode !== "setup" || !selectedBone.groupKey} title={selectedBone.groupKey ? "Center and size this bone to its bound SVG group" : "Bind this bone to a group first"} onclick={fitSelectedBoneToGroup}>
            <span class="fit-reticle">⌖</span><span><strong>FIT TO GROUP</strong><small>PRESERVE ANGLE · 8% INSET</small></span><i>↔</i>
          </button>
        </div>
        {@const bonePose = rigEditMode === "setup" ? currentSetupBoneTransform(selectedBone.id) : currentBoneTransform(selectedBone.id)}
        {@const boneControlsDisabled = rigEditMode === "pose" && !activePose}
        <div class="control-section" class:disabled={boneControlsDisabled}><div class="section-label"><span>{rigEditMode === "setup" ? "GUIDE PLACEMENT" : "POSE TRANSFORM"}</span><small>NON-DESTRUCTIVE</small></div><div class="control-grid"><label><span>X</span><input disabled={boneControlsDisabled} type="number" step="1" value={bonePose.x.toFixed(2)} oninput={(event) => changeBonePoseNumber("x", event)} /></label><label><span>Y</span><input disabled={boneControlsDisabled} type="number" step="1" value={bonePose.y.toFixed(2)} oninput={(event) => changeBonePoseNumber("y", event)} /></label></div><label class="wide-control second-row"><span>R</span><input disabled={boneControlsDisabled} type="number" step="1" value={bonePose.rotation.toFixed(2)} oninput={changeBoneRotation} /></label><div class="control-grid second-row"><label><span>W</span><input disabled={boneControlsDisabled} type="number" min="0.02" step="0.05" value={bonePose.scaleX.toFixed(3)} oninput={(event) => changeBonePoseNumber("scaleX", event)} /></label><label><span>H</span><input disabled={boneControlsDisabled} type="number" min="0.02" step="0.05" value={bonePose.scaleY.toFixed(3)} oninput={(event) => changeBonePoseNumber("scaleY", event)} /></label></div></div>
        <div class="danger-zone"><button disabled={rigEditMode !== "setup"} onclick={deleteBone}>DELETE BONE + CHILDREN</button></div>
      {:else if selectedGroup}
        <div class="selection-card"><span class="selection-chip">G</span><div><small>ACTIVE GROUP</small><strong>{selectedGroup.label}</strong></div></div>
        {#if !activePose}<div class="lock-notice"><span>▣</span><div><strong>Rest pose is locked</strong><small>Create a pose to transform this group.</small></div></div>{/if}
        {#if activeTool === "shape"}
          <div class="shape-inspector" class:empty={!shapeEditor}>
            <div class="section-label"><span>VECTOR VOLUME</span><small>VS IMMUTABLE SOURCE</small></div>
            {#if shapeEditor}
              <div class:stable={Math.abs(shapeVolumePercent - 100) <= 2} class:caution={Math.abs(shapeVolumePercent - 100) > 2 && Math.abs(shapeVolumePercent - 100) <= 10} class="volume-score"><strong>{shapeVolumePercent.toFixed(1)}%</strong><span>{shapeVolumePercent < 99.95 ? "SMALLER" : shapeVolumePercent > 100.05 ? "LARGER" : "EXACT"}</span></div>
              <div class="volume-track"><i style={`width:${Math.min(100, shapeVolumePercent)}%`}></i><b style="left:100%"></b></div>
              <div class="volume-scale"><span>0%</span><span>SOURCE · 100%</span></div>
              {#if selectedShapeNodeIndex !== null}<div class={`node-mode-summary mode-${selectedShapeNodeMode}`}><span>NODE {String(selectedShapeNodeIndex + 1).padStart(2, "0")}</span><strong>{selectedShapeNodeMode === "sharp" ? "CORNER" : selectedShapeNodeMode.toUpperCase()}</strong><small>{selectedShapeNodeMode === "sharp" ? "NO PULLERS · SQUARE / CUSP" : selectedShapeNodeMode === "smooth" ? "TWO INDEPENDENT PULLERS" : "TWO LINKED PULLERS"}</small></div>{:else}<div class="node-mode-summary empty"><span>SELECT AN ANCHOR</span><small>PULLERS APPEAR ONLY FOR THAT NODE</small></div>{/if}
              <p>Area is measured from this pose's edited path. Moving Bézier nodes never changes the source SVG or another pose.</p>
              <button class="shape-reset" disabled={!activePose || !activePose.shapePaths?.[shapeEditor.shapeKey]} onclick={resetSelectedShape}>RESTORE THIS SHAPE TO 100%</button>
            {:else}
              <p>Select a supported path, rectangle, circle, ellipse, line, or polygon on the canvas.</p>
            {/if}
          </div>
        {/if}
        {@const transform = currentTransform(selectedGroup.key)}
        <div class="control-section" class:disabled={!activePose}><div class="section-label"><span>POSITION</span><small>SVG UNITS</small></div><div class="control-grid"><label><span>X</span><input disabled={!activePose} type="number" step="1" value={transform.x.toFixed(2)} oninput={(event) => changeTransform("x", event)} /></label><label><span>Y</span><input disabled={!activePose} type="number" step="1" value={transform.y.toFixed(2)} oninput={(event) => changeTransform("y", event)} /></label></div></div>
        <div class="control-section" class:disabled={!activePose}><div class="section-label"><span>ROTATION</span><small>DEGREES</small></div><label class="wide-control"><span>R</span><input disabled={!activePose} type="number" step="1" value={transform.rotation.toFixed(2)} oninput={(event) => changeTransform("rotation", event)} /></label></div>
        <div class="control-section" class:disabled={!activePose}><div class="section-label"><span>SCALE</span><small>LOCAL</small></div><div class="control-grid"><label><span>W</span><input disabled={!activePose} type="number" min="0.01" step="0.05" value={transform.scaleX.toFixed(3)} oninput={(event) => changeTransform("scaleX", event)} /></label><label><span>H</span><input disabled={!activePose} type="number" min="0.01" step="0.05" value={transform.scaleY.toFixed(3)} oninput={(event) => changeTransform("scaleY", event)} /></label></div></div>
      {:else}<div class="empty-panel compact"><span class="empty-glyph">⌖</span><strong>No selection</strong><p>Select an SVG group or bone.</p></div>{/if}
      <div class="export-panel">
        <div class="section-label"><span>PIXEL OUTPUT</span><small>PNG</small></div>
        <div class="resolution-control"><label><span>W</span><input type="number" min="1" max="16384" bind:value={outputWidth} onchange={() => { dirty = true; schedulePreview(); schedulePersist(); }} /></label><span class="times">×</span><label><span>H</span><input type="number" min="1" max="16384" bind:value={outputHeight} onchange={() => { dirty = true; schedulePreview(); schedulePersist(); }} /></label></div>
        <div class:disabled={aiPixelFilter} class="pixel-option"><div class="option-copy"><span>EDGE ANTIALIAS</span><strong>{aiPixelFilter ? "OVERRIDDEN · HARD" : antiAlias === 0 ? "0 · BINARY ALPHA" : `${antiAlias}%`}</strong></div><input aria-label="Edge antialias" disabled={aiPixelFilter} type="range" min="0" max="100" step="1" bind:value={antiAlias} oninput={() => { dirty = true; schedulePreview(); schedulePersist(); }} /></div>
        <label class="select-control pixel-fit"><span>↔</span><select bind:value={resizeMode} onchange={() => { dirty = true; schedulePreview(); schedulePersist(); }}><option value="contain">FIT RATIO · CENTERED</option><option value="stretch">STRETCH TO OUTPUT</option></select></label>
        <p class="option-note">The rasterizer always outputs absolute opaque or transparent pixels and never blends neighboring SVG groups.</p>
        <div class:active={aiPixelFilter} class:processing={aiPreviewBusy} class="ai-filter-card">
          <label class="ai-toggle"><input type="checkbox" bind:checked={aiPixelFilter} disabled={!desktopRuntime} onchange={() => { dirty = true; schedulePreview(); schedulePersist(); }} /><span class="toggle-track"><i></i></span><span><strong>PIXEL ART RASTERIZER</strong><small>{aiPreviewBusy ? "RESOLVING · EDITOR STAYS LIVE" : desktopRuntime ? "RUST · DETERMINISTIC" : "DESKTOP APP ONLY"}</small></span></label>
          <div class="rasterizer-method"><span>ADAPTIVE SS</span><i></i><span>NO BLEND</span><i></i><span>POSE LOCK</span></div>
          <div class="ai-palette" class:disabled={!aiPixelFilter}><div class="option-copy"><span>LOCKED SVG PALETTE</span><strong>{aiPaletteSize} COLORS</strong></div><input aria-label="Locked SVG palette colors" disabled={!aiPixelFilter} type="range" min="2" max="64" step="1" bind:value={aiPaletteSize} oninput={() => { dirty = true; schedulePreview(); schedulePersist(); }} /></div>
          <div class="ai-palette" class:disabled={!aiPixelFilter}><div class="option-copy"><span>CONTOUR CLEANUP</span><strong>{pixelContourStrength < 25 ? "OFF" : pixelContourStrength < 75 ? "DOUBLES" : "STRICT"}</strong></div><input aria-label="Contour cleanup" disabled={!aiPixelFilter} type="range" min="0" max="100" step="1" bind:value={pixelContourStrength} oninput={() => { dirty = true; schedulePreview(); schedulePersist(); }} /></div>
          <div class="ai-palette coverage-threshold" class:disabled={!aiPixelFilter}><div class="option-copy"><span>EDGE COVERAGE THRESHOLD</span><strong>{pixelCoverageThreshold}% · {pixelCoverageThreshold < 40 ? "PERMISSIVE" : pixelCoverageThreshold < 60 ? "BALANCED" : pixelCoverageThreshold < 75 ? "STRICT" : "VERY STRICT"}</strong></div><input aria-label="Edge coverage threshold" disabled={!aiPixelFilter} type="range" min="10" max="90" step="1" bind:value={pixelCoverageThreshold} oninput={() => { dirty = true; schedulePreview(); schedulePersist(); }} /><div class="threshold-scale"><span>KEEP THIN DETAILS</span><i></i><span>TIGHTEN SILHOUETTE</span></div></div>
          <label class="select-control raster-detail" class:disabled={!aiPixelFilter}><span>▪</span><select aria-label="Minimum pixel cluster" disabled={!aiPixelFilter} bind:value={pixelDetailFloor} onchange={() => { dirty = true; schedulePreview(); schedulePersist(); }}><option value={1}>KEEP 1 PX DETAILS</option><option value={2}>REMOVE 1 PX NOISE</option><option value={3}>MINIMUM 3 PX CLUSTER</option><option value={4}>MINIMUM 4 PX CLUSTER</option></select></label>
          <p>Coverage decides how much vector source must cross a pixel before it becomes solid. Raise it to remove weak edge touches; lower it to preserve thin features.</p>
        </div>
        <button class="export-wide" disabled={!sourceSvg} onclick={exportPng}>EXPORT ACTIVE POSE <span>↓</span></button>
        <button class="export-wide secondary" disabled={!sourceSvg || poses.length === 0} onclick={exportTileset}>EXPORT {poses.length} POSE{poses.length === 1 ? "" : "S"} <span>▦</span></button>
      </div>
    </aside>
  </section>

  <footer class="pose-dock">
    <div class="pose-dock-title"><span class="eyebrow">NON-DESTRUCTIVE</span><strong>POSES</strong></div>
    <div class="pose-rail">
      <button class:active={activePoseId === "rest"} class="pose-card rest" onclick={() => choosePose("rest")} disabled={!sourceSvg}><span class="pose-number">00</span><span><strong>REST</strong><small>ORIGINAL SVG</small></span><i>LOCKED</i></button>
      {#each poses as pose, index}<div class:active={activePoseId === pose.id} class="pose-card editable"><button class="pose-select" onclick={() => choosePose(pose.id)}><span class="pose-number">{String(index + 1).padStart(2, "0")}</span><span><strong>{pose.name}</strong><small>{Object.keys(pose.transforms).length} GROUP · {Object.keys(pose.boneTransforms ?? {}).length} BONE</small></span></button><button class="pose-delete" title="Delete pose" onclick={() => deletePose(pose)}>×</button></div>{/each}
      <button class="new-pose" disabled={!sourceSvg} onclick={addPose}><span>＋</span><strong>NEW POSE</strong><small>SNAPSHOT CURRENT</small></button>
    </div>
    <div class="pose-actions">
      <div class="playback-control"><button class:playing={isPlaying} disabled={!sourceSvg || poses.length === 0} onclick={togglePlayback}><span>{isPlaying ? "■" : "▶"}</span>{isPlaying ? "STOP" : "PLAY POSES"}</button><select aria-label="Playback speed" value={playbackFps} onchange={changePlaybackFps}><option value="1">1 FPS</option><option value="2">2 FPS</option><option value="4">4 FPS</option><option value="8">8 FPS</option><option value="12">12 FPS</option></select></div>
      <button class:active={onionSkin} class:paused={onionSkin && isPlaying} class="onion-skin-toggle" disabled={!sourceSvg || poses.length < 2} aria-pressed={onionSkin} onclick={toggleOnionSkin} title="Show previous pose in red and next pose in blue on the pixel canvas"><span class="onion-colors"><i></i><i></i></span><strong>ONION SKIN</strong><small>{onionSkin && isPlaying ? "PAUSED DURING PLAY" : "PREV 40% · NEXT 40%"}</small><b>{onionSkin ? "ON" : "OFF"}</b></button>
      <div class="onion-scope-control"><button class:active={onionSkinScope === "selected"} class="onion-scope-toggle" disabled={!onionSkin || !selectedBone?.groupKey} aria-pressed={onionSkinScope === "selected"} onclick={toggleOnionSkinScope} title="Choose whether onion skin shows all vectors or only the selected bone's vector"><strong>{onionSkinScope === "all" ? "ALL VECTORS" : "SELECTED BONE"}</strong><small>{onionSkinScope === "all" ? "ALL BONES" : selectedBone?.name ?? "SELECT A BOUND BONE"}</small></button><select class="onion-radius-control" aria-label="Onion skin neighbor level" disabled={!onionSkin || onionSkinScope !== "selected" || !selectedBone?.groupKey} value={onionSkinRadius} onchange={changeOnionSkinRadius}>{#each [1, 2, 3, 4, 5, 6, 7, 8] as level}<option value={level}>{level} neighbor{level === 1 ? "" : "s"}</option>{/each}</select></div>
      <small class="frame-readout">{poses.length} POSE{poses.length === 1 ? "" : "S"} · {frameCount} EXPORT FRAME{frameCount === 1 ? "" : "S"}</small>
      {#if activePose}<input aria-label="Pose name" value={activePose.name} onchange={renamePose} /><button onclick={duplicatePose}>DUPLICATE</button>{:else}<span>REST PREVIEW · NOT EXPORTED</span>{/if}
    </div>
  </footer>
</main>
