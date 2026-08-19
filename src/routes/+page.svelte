<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { open, save } from "@tauri-apps/plugin-dialog";
  import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
  import initStudioCore, { transform_matrix } from "$lib/wasm/studio_core.js";
  import { composeBoneTransform, createPose, identityBoneTransform, identityTransform, relativeBoneTransform, type Bone, type BonePoseTransform, type GroupTransform, type PixelResizeMode, type Pose, type SvgGroup } from "$lib/editor/model";
  import { highlightBoneWrapper, prepareSvg, selectWrapper, serializeForExport, setWrapperMatrix, setWrapperVisibility } from "$lib/editor/svg";
  import { loadCanvasKit, rasterizeSvg, renderEncodedPixelPreview, renderPixelPreview } from "$lib/editor/pixel-preview";
  import { boneDepth, boneGroupMatrices, boneWorldMap, composeGroupLocalMatrices, fitBoneToGroupBounds, invertMatrix, multiplyMatrix, translateBoneEndpoints, wouldCreateCycle, type Matrix } from "$lib/editor/rig";
  import { appendHistory, cloneSerializable, snapshotsEqual, type HistoryEntry } from "$lib/editor/history";
  import { decodeAstdProject, encodeAstdProject, type AstdProjectState } from "$lib/editor/project";
  import "./studio.css";

  type EditorTool = "move" | "rotate" | "scale";
  type RigEditMode = "setup" | "pose";
  type BoneGesture = "move" | "rotate-start" | "rotate-end" | "scale-start" | "scale-end";
  type PrimaryView = "vector" | "rig";
  type Session = { sourceSvg: string; fileName: string; poses: Pose[]; bones: Bone[]; activePoseId: string; outputWidth: number; outputHeight: number; antiAlias: number; resizeMode: PixelResizeMode; rigEditMode?: RigEditMode; preferredRigEditMode?: RigEditMode; aiPixelFilter?: boolean; aiPaletteSize?: number; primaryView?: PrimaryView | null; pixelVisible?: boolean; playbackFps?: number; setupBoneTransforms?: Record<string, BonePoseTransform>; rigTransformModel?: number };
  type DocumentSnapshot = { poses: Pose[]; bones: Bone[]; setupBoneTransforms: Record<string, BonePoseTransform>; activePoseId: string; selectedGroupKey: string | null; selectedBoneId: string | null };
  type DragState = { pointerId: number; key: string; startPoint: { x: number; y: number }; startTransform: GroupTransform; inverse: DOMMatrix; rootToTool: Matrix; pivot: { x: number; y: number }; startAngle: number; startDistance: number; startDx: number; startDy: number; historyBefore: DocumentSnapshot };
  type BoneDragState = { pointerId: number; boneId: string; gesture: BoneGesture; inverse: DOMMatrix; startPoint: DOMPoint; startBone: Bone; startSetup: BonePoseTransform; startPose: BonePoseTransform; startEffective: BonePoseTransform; parentInverse: Matrix; startWorld: { startX: number; startY: number; endX: number; endY: number }; historyBefore: DocumentSnapshot };

  const cursorSvg = (body: string, fallback: string, angle = 0) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g transform="rotate(${angle} 16 16)" fill="none" stroke="#f4c96d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="#101416" stroke-width="4" d="${body}"/><path d="${body}"/></g></svg>`)}") 16 16, ${fallback}`;
  const moveCursor = cursorSvg("M16 3l-4 4m4-4l4 4M16 29l-4-4m4 4l4-4M3 16l4-4m-4 4l4 4M29 16l-4-4m4 4l-4 4M16 4v24M4 16h24", "move");
  const rotateCursor = cursorSvg("M8 11a10 10 0 0 1 16-3l2 3m-2-3l-3 2M24 21a10 10 0 0 1-16 3l-2-3m2 3l3-2", "alias");
  function resizeCursor(angle: number) {
    return cursorSvg("M16 4l-4 4m4-4l4 4M16 28l-4-4m4 4l4-4M16 5v22", "ew-resize", Math.round(angle + 90));
  }

  let svgHost: HTMLDivElement;
  let previewCanvas: HTMLCanvasElement;
  let rigSvg = $state<SVGSVGElement>();
  let fileInput: HTMLInputElement;
  let projectFileInput: HTMLInputElement;
  let sourceSvg = $state("");
  let fileName = $state("No source loaded");
  let groups = $state<SvgGroup[]>([]);
  let poses = $state<Pose[]>([]);
  let bones = $state<Bone[]>([]);
  let setupBoneTransforms = $state<Record<string, BonePoseTransform>>({});
  let activePoseId = $state("rest");
  let selectedGroupKey = $state<string | null>(null);
  let selectedBoneId = $state<string | null>(null);
  let outputWidth = $state(64);
  let outputHeight = $state(64);
  let antiAlias = $state(0);
  let resizeMode = $state<PixelResizeMode>("contain");
  let aiPixelFilter = $state(false);
  let aiPaletteSize = $state(16);
  let activeTool = $state<EditorTool>("move");
  let lockRatio = $state(true);
  let preserveArea = $state(false);
  let rigEditMode = $state<RigEditMode>("setup");
  let preferredRigEditMode = $state<RigEditMode>("setup");
  let viewMode = $state<PrimaryView | null>("vector");
  let pixelVisible = $state(false);
  let leftMode = $state<"groups" | "rig">("groups");
  let viewBox = $state<[number, number, number, number]>([0, 0, 512, 512]);
  let zoom = $state(1);
  let status = $state("Ready for an SVG");
  let warnings = $state<string[]>([]);
  let canvasBackend = $state("CanvasKit loading");
  let wasmReady = $state(false);
  let desktopRuntime = $state(false);
  let dirty = $state(false);
  let projectPath = $state<string | null>(null);
  let isPlaying = $state(false);
  let playbackFps = $state(2);
  let playbackTimer: ReturnType<typeof setTimeout> | null = null;
  let drag: DragState | null = null;
  let boneDrag = $state<BoneDragState | null>(null);
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let setupFrozenMatrices: Record<string, Matrix> = {};
  let undoStack = $state<HistoryEntry<DocumentSnapshot>[]>([]);
  let redoStack = $state<HistoryEntry<DocumentSnapshot>[]>([]);
  const pivots: Record<string, { x: number; y: number }> = {};
  const worldPivots: Record<string, { x: number; y: number }> = {};
  const wrapperParentMatrices: Record<string, Matrix> = {};

  const activePose = $derived(poses.find((pose) => pose.id === activePoseId) ?? null);
  const selectedGroup = $derived(groups.find((group) => group.key === selectedGroupKey) ?? null);
  const selectedBone = $derived(bones.find((bone) => bone.id === selectedBoneId) ?? null);
  // Setup and Pose share the same visible guide placement. The mode only
  // decides whether the artwork is frozen or follows those guides.
  const boneWorlds = $derived(boneWorldMap(bones, effectiveBoneTransforms(activePose)));
  const renderedBones = $derived([...bones].sort((left, right) => Number(left.id === selectedBoneId) - Number(right.id === selectedBoneId)));
  const canEdit = $derived(Boolean(sourceSvg && activePose));
  const frameCount = $derived(poses.length);
  const projectName = $derived(projectPath?.split(/[\\/]/).pop() ?? "UNSAVED .ASTD");

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
        return { ...pose, boneTransforms: migrated, visibility: pose.visibility ?? {} };
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
      preferredRigEditMode = session.preferredRigEditMode === "pose" || session.rigEditMode === "pose" ? "pose" : "setup";
      rigEditMode = restoredActivePoseId === "rest" ? "setup" : preferredRigEditMode;
      viewMode = session.primaryView === "rig" || session.primaryView === null ? session.primaryView : "vector";
      pixelVisible = session.pixelVisible === true;
      if (!viewMode && !pixelVisible) viewMode = "vector";
      playbackFps = [1, 2, 4, 8].includes(session.playbackFps || 0) ? session.playbackFps! : 2;
      requestAnimationFrame(() => { if (rigEditMode === "setup") setupFrozenMatrices = calculatedGroupMatrices(); applyAllTransforms(); });
      status = `Restored ${session.fileName}`;
      schedulePersist();
    } catch (error) { console.warn("Unable to restore prior session", error); }
  });

  onDestroy(() => {
    if (previewTimer) clearTimeout(previewTimer);
    if (persistTimer) clearTimeout(persistTimer);
    if (playbackTimer) clearTimeout(playbackTimer);
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
  function calculatedGroupMatricesFor(pose: Pose | null): Record<string, Matrix> {
    const rigMatrices = boneGroupMatrices(bones, effectiveBoneTransforms(pose), setupBoneTransforms);
    const directMatrices = Object.fromEntries(groups.map((group) => [group.key, matrixFor(transformForPose(group.key, pose)) as Matrix]));
    return composeGroupLocalMatrices(groups, wrapperParentMatrices, rigMatrices, directMatrices);
  }
  function calculatedGroupMatrices(): Record<string, Matrix> { return calculatedGroupMatricesFor(activePose); }
  function applyAllTransforms() {
    if (!svgHost) return;
    const calculated = calculatedGroupMatrices();
    const freezeRig = viewMode === "rig" && rigEditMode === "setup" && !isPlaying;
    for (const group of groups) {
      setWrapperMatrix(svgHost, group.key, freezeRig && setupFrozenMatrices[group.key] ? setupFrozenMatrices[group.key] : calculated[group.key]);
      setWrapperVisibility(svgHost, group.key, groupIsVisible(group.key));
    }
    selectWrapper(svgHost, selectedGroupKey);
    highlightBoneWrapper(svgHost, selectedBone?.groupKey ?? null);
    schedulePreview();
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
  function collectPivots() {
    const root = svgHost.querySelector("svg");
    const rootCtm = root?.getCTM();
    const rootInverse = rootCtm?.inverse();
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
  }
  async function loadSvgSource(svg: string, name: string, persist = true) {
    const prepared = prepareSvg(svg);
    sourceSvg = svg; fileName = name; groups = prepared.groups; warnings = prepared.warnings; viewBox = prepared.viewBox;
    selectedGroupKey = groups[0]?.key ?? null; selectedBoneId = null; poses = []; bones = []; setupBoneTransforms = {}; activePoseId = "rest"; undoStack = []; redoStack = []; projectPath = null;
    svgHost.innerHTML = prepared.markup;
    requestAnimationFrame(() => { collectPivots(); applyAllTransforms(); });
    status = `${groups.length} editable group${groups.length === 1 ? "" : "s"} indexed`;
    dirty = persist;
    if (persist) schedulePersist();
  }
  async function openSvg() {
    try {
      if (isTauri()) {
        const path = await open({ multiple: false, directory: false, filters: [{ name: "Scalable Vector Graphics", extensions: ["svg"] }] });
        if (!path) return;
        await loadSvgSource(await readTextFile(path), path.split(/[\\/]/).pop() || "artwork.svg");
      } else fileInput.click();
    } catch (error) { status = error instanceof Error ? error.message : String(error); }
  }
  async function receiveFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement, file = input.files?.[0];
    if (!file) return;
    try { await loadSvgSource(await file.text(), file.name); }
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
      preferredRigEditMode,
      primaryView: viewMode,
      pixelVisible,
      playbackFps,
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
    preferredRigEditMode = saved.preferredRigEditMode;
    rigEditMode = activePoseId === "rest" ? "setup" : preferredRigEditMode;
    viewMode = saved.primaryView; pixelVisible = saved.pixelVisible;
    if (!viewMode && !pixelVisible) viewMode = "vector";
    leftMode = viewMode === "rig" ? "rig" : "groups";
    playbackFps = saved.playbackFps; zoom = saved.zoom;
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
  function selectGroup(key: string) { selectedGroupKey = key; selectWrapper(svgHost, key); }
  function addPose() {
    if (!sourceSvg) return;
    const before = captureDocument();
    const pose = createPose(`Pose ${String(poses.length + 1).padStart(2, "0")}`, activePose?.transforms ?? {}, activePose?.boneTransforms ?? {}, activePose?.visibility ?? {});
    poses = [...poses, pose]; activePoseId = pose.id; rigEditMode = preferredRigEditMode; dirty = false; applyAllTransforms(); schedulePersist();
    commitHistory("Create pose", before);
    status = `${pose.name} created as an independent pose`;
  }
  function duplicatePose() {
    if (!activePose) return;
    const before = captureDocument();
    const pose = createPose(`${activePose.name} copy`, activePose.transforms, activePose.boneTransforms, activePose.visibility);
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
  function togglePlayback() {
    if (isPlaying) { stopPlayback(); status = "Pose playback stopped"; return; }
    if (!sourceSvg || poses.length === 0) { status = "Create at least one pose to play the animation."; return; }
    activePoseId = poses[0].id;
    rigEditMode = preferredRigEditMode;
    isPlaying = true;
    applyAllTransforms();
    playbackTimer = setTimeout(playbackStep, 1000 / playbackFps);
    status = `Playing ${poses.length} pose${poses.length === 1 ? "" : "s"} at ${playbackFps} FPS`;
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
  function resetSelected() {
    if (!selectedGroupKey || !activePose) return;
    const pivot = pivots[selectedGroupKey] ?? { x: 0, y: 0 };
    updateTransform(selectedGroupKey, { ...identityTransform(), pivotX: pivot.x, pivotY: pivot.y });
  }
  function selectBone(id: string) {
    selectedBoneId = id;
    highlightBoneWrapper(svgHost, bones.find((bone) => bone.id === id)?.groupKey ?? null);
    if (viewMode !== "rig") showRig(); else leftMode = "rig";
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
      const fitted = fitBoneToGroupBounds({
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
  function addBone() {
    if (!sourceSvg) return;
    const before = captureDocument();
    const parent = bones.find((bone) => bone.id === selectedBoneId) ?? null;
    const pivot = selectedGroupKey ? worldPivots[selectedGroupKey] : null;
    const group = groups.find((item) => item.key === selectedGroupKey);
    const parentWorld = parent ? boneWorldMap(bones)[parent.id] : null;
    const targetDistance = parentWorld && pivot ? Math.hypot(pivot.x - parentWorld.endX, pivot.y - parentWorld.endY) : 0;
    const targetAngle = parentWorld && pivot ? Math.atan2(pivot.y - parentWorld.endY, pivot.x - parentWorld.endX) * 180 / Math.PI : 0;
    const bone: Bone = {
      id: crypto.randomUUID(),
      name: group?.label ? `${group.label} bone` : `Bone ${String(bones.length + 1).padStart(2, "0")}`,
      parentId: parent?.id ?? null,
      groupKey: selectedGroupKey,
      x: parent ? parent.length : (pivot?.x ?? viewBox[0] + viewBox[2] / 2),
      y: parent ? 0 : (pivot?.y ?? viewBox[1] + viewBox[3] / 2),
      length: parent ? Math.max(12, targetDistance || parent.length * 0.72) : Math.max(32, Math.min(viewBox[2], viewBox[3]) * 0.16),
      restRotation: parentWorld && pivot ? targetAngle - parentWorld.angle : 0,
    };
    const fitted = bone.groupKey ? fittedBoneForGroup(bone, bone.groupKey) : null;
    const placedBone = fitted?.bone ?? bone;
    bones = [...bones.map((item) => item.groupKey === placedBone.groupKey ? { ...item, groupKey: null } : item), placedBone];
    if (fitted) setupBoneTransforms = { ...setupBoneTransforms, [placedBone.id]: fitted.setup };
    selectedBoneId = placedBone.id; showRig();
    applyAllTransforms(); schedulePersist();
    commitHistory("Add bone", before);
    status = fitted
      ? `${placedBone.name} centered and fitted to ${group?.label}`
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
    const fitted = groupKey ? fittedBoneForGroup({ ...selectedBone, groupKey }, groupKey) : null;
    const nextSelected = fitted?.bone ?? { ...selectedBone, groupKey };
    bones = bones.map((bone) => bone.id === selectedBone.id
      ? nextSelected
      : groupKey && bone.groupKey === groupKey ? { ...bone, groupKey: null } : bone);
    if (fitted) setupBoneTransforms = { ...setupBoneTransforms, [selectedBone.id]: fitted.setup };
    applyAllTransforms(); schedulePersist();
    commitHistory(groupKey ? "Bind and fit bone to group" : "Unbind bone from group", before);
    status = groupKey
      ? fitted ? `${selectedBone.name} bound, centered, and fitted to ${groups.find((group) => group.key === groupKey)?.label}` : `${selectedBone.name} bound to an empty group`
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
  function resetBoneRotation() {
    if (!selectedBone) return;
    if (rigEditMode === "setup") updateSetupBoneTransform(selectedBone.id, identityBoneTransform());
    else if (activePose) updateBonePose(selectedBone.id, identityBoneTransform());
  }
  function changeBonePoseNumber(field: keyof BonePoseTransform, event: Event) {
    if (!selectedBone || (rigEditMode === "pose" && !activePose)) return;
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    const current = rigEditMode === "setup" ? currentSetupBoneTransform(selectedBone.id) : currentBoneTransform(selectedBone.id);
    const next = { ...current, [field]: field.startsWith("scale") ? Math.max(0.02, value) : value };
    if (rigEditMode === "setup") updateSetupBoneTransform(selectedBone.id, next);
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
    if (rigEditMode === "setup") updateSetupBoneTransform(state.boneId, relativeBoneTransform(effective, state.startPose), false, false);
    else updateBonePose(state.boneId, relativeBoneTransform(effective, state.startSetup), false, false);
  }
  function bonePointerDown(event: PointerEvent, boneId: string, gesture: BoneGesture) {
    selectBone(boneId);
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
      startWorld: { startX: world.startX, startY: world.startY, endX: world.endX, endY: world.endY },
      historyBefore: captureDocument(),
    };
    rigSvg?.setPointerCapture(event.pointerId);
    event.preventDefault(); event.stopPropagation();
  }
  function boneOverlayPointerDown(event: PointerEvent) {
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
      const angle = Math.atan2(point.y - start.startY, point.x - start.startX);
      applyBoneGeometry(boneDrag, { x: start.startX, y: start.startY }, { x: start.startX + Math.cos(angle) * length, y: start.startY + Math.sin(angle) * length });
    } else if (boneDrag.gesture === "rotate-start") {
      const angleFromEnd = Math.atan2(point.y - start.endY, point.x - start.endX);
      const worldStart = { x: start.endX + Math.cos(angleFromEnd) * length, y: start.endY + Math.sin(angleFromEnd) * length };
      applyBoneGeometry(boneDrag, worldStart, { x: start.endX, y: start.endY });
    } else if (boneDrag.gesture === "scale-end") {
      const nextLength = Math.max(1, (point.x - start.startX) * unit.x + (point.y - start.startY) * unit.y);
      applyBoneGeometry(boneDrag, { x: start.startX, y: start.startY }, { x: start.startX + unit.x * nextLength, y: start.startY + unit.y * nextLength });
    } else {
      const nextLength = Math.max(1, (start.endX - point.x) * unit.x + (start.endY - point.y) * unit.y);
      applyBoneGeometry(boneDrag, { x: start.endX - unit.x * nextLength, y: start.endY - unit.y * nextLength }, { x: start.endX, y: start.endY });
    }
  }
  function bonePointerUp(event: PointerEvent) {
    if (!boneDrag || boneDrag.pointerId !== event.pointerId) return;
    const before = boneDrag.historyBefore;
    boneDrag = null; commitHistory("Transform bone", before); schedulePreview(); status = rigEditMode === "setup" ? "Guide placement updated; artwork remains frozen" : `${activePose?.name ?? "Pose"} rig transform updated`;
  }
  function pointerDown(event: PointerEvent) {
    if (viewMode === "rig") return;
    const wrapper = (event.target as Element).closest("[data-studio-group]") as SVGGElement | null;
    const key = wrapper?.dataset.studioGroup;
    if (!wrapper || !key) return;
    selectGroup(key);
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
    if ((event.target as HTMLElement | null)?.matches("input,select,textarea")) return;
    const key = event.key.toLowerCase();
    if (key === "v") { activeTool = "move"; return; }
    if (key === "r") { activeTool = "rotate"; return; }
    if (key === "s") { activeTool = "scale"; return; }
    if (!event.key.startsWith("Arrow")) return;
    const amount = event.shiftKey ? 10 : 1;
    if (viewMode === "rig" && selectedBone) {
      if (rigEditMode === "setup") {
        const next = { ...currentSetupBoneTransform(selectedBone.id) };
        if (event.key === "ArrowLeft") next.x -= amount;
        if (event.key === "ArrowRight") next.x += amount;
        if (event.key === "ArrowUp") next.y -= amount;
        if (event.key === "ArrowDown") next.y += amount;
        updateSetupBoneTransform(selectedBone.id, next);
      } else if (activePose) {
        const next = { ...currentBoneTransform(selectedBone.id) };
        if (event.key === "ArrowLeft") next.x -= amount;
        if (event.key === "ArrowRight") next.x += amount;
        if (event.key === "ArrowUp") next.y -= amount;
        if (event.key === "ArrowDown") next.y += amount;
        updateBonePose(selectedBone.id, next);
      }
      event.preventDefault(); return;
    }
    if (!selectedGroupKey || !activePose) return;
    const transform = { ...currentTransform(selectedGroupKey) };
    if (event.key === "ArrowLeft") transform.x -= amount;
    if (event.key === "ArrowRight") transform.x += amount;
    if (event.key === "ArrowUp") transform.y -= amount;
    if (event.key === "ArrowDown") transform.y += amount;
    updateTransform(selectedGroupKey, transform); event.preventDefault();
  }
  function schedulePreview() { if (previewTimer) clearTimeout(previewTimer); previewTimer = setTimeout(() => void refreshPreview(), 90); }
  async function canvasPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encoding failed.")), "image/png"));
    return new Uint8Array(await png.arrayBuffer());
  }
  async function refreshPreview() {
    if (!svgHost || !previewCanvas || !sourceSvg) return;
    try {
      const width = Math.max(1, Math.round(outputWidth));
      const height = Math.max(1, Math.round(outputHeight));
      const svg = serializeForExport(svgHost);
      if (aiPixelFilter && isTauri()) {
        const source = await rasterizeSvg(svg, width, height, { antiAlias, resizeMode });
        const refined = await invoke<number[]>("refine_pixel_png", { png: Array.from(await canvasPngBytes(source)), paletteSize: Math.round(aiPaletteSize) });
        await renderEncodedPixelPreview(new Uint8Array(refined), previewCanvas, width, height);
        canvasBackend = `Offline AI · ${aiPaletteSize} colors`;
        return;
      }
      const backend = await renderPixelPreview(
        svg,
        width,
        height,
        previewCanvas,
        { antiAlias, resizeMode },
      );
      canvasBackend = backend === "canvaskit" ? "CanvasKit · Skia/WASM" : "Canvas 2D fallback";
    } catch (error) { console.error(error); }
  }
  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => localStorage.setItem("asset-studio:last-session", JSON.stringify({ sourceSvg, fileName, poses, bones, setupBoneTransforms, rigTransformModel: 2, activePoseId, outputWidth, outputHeight, antiAlias, resizeMode, rigEditMode, preferredRigEditMode, aiPixelFilter, aiPaletteSize, primaryView: viewMode, pixelVisible, playbackFps } satisfies Session)), 250);
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
    const svg = serializeForExport(svgHost), base = fileName.replace(/\.svg$/i, "");
    const poseName = (activePose?.name ?? "rest").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
    const defaultName = `${base}-${poseName}-${outputWidth}x${outputHeight}.png`;
    try {
      if (isTauri()) {
        const path = await save({ defaultPath: defaultName, filters: [{ name: "Portable Network Graphics", extensions: ["png"] }] });
        if (!path) return;
        await invoke("export_png", { svg, path, width: Math.round(outputWidth), height: Math.round(outputHeight), antiAlias: Math.round(antiAlias), resizeMode, aiFilter: aiPixelFilter, aiPaletteSize: Math.round(aiPaletteSize) });
        status = `Exported ${path.split(/[\\/]/).pop()}`;
      } else { await exportPngInBrowser(svg, defaultName); status = `Exported ${defaultName}`; }
    } catch (error) { status = error instanceof Error ? error.message : String(error); }
  }
  function serializePoseFrame(pose: Pose | null): string {
    const matrices = calculatedGroupMatricesFor(pose);
    for (const group of groups) {
      setWrapperMatrix(svgHost, group.key, matrices[group.key]);
      setWrapperVisibility(svgHost, group.key, groupIsVisible(group.key, pose));
    }
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
        await invoke("export_tileset", { svgs, path, width: Math.round(outputWidth), height: Math.round(outputHeight), antiAlias: Math.round(antiAlias), resizeMode, aiFilter: aiPixelFilter, aiPaletteSize: Math.round(aiPaletteSize) });
        status = `Exported ${svgs.length}-frame tileset`;
      } else {
        await exportTilesetInBrowser(svgs, defaultName);
        status = `Exported ${defaultName}${aiPixelFilter ? " without desktop AI refinement" : ""}`;
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
    <div class="top-actions"><div class="history-actions" aria-label="Edit history"><button disabled={!undoStack.length} onclick={undo} title="Undo (Ctrl+Z)">↶<small>CTRL Z</small></button><button disabled={!redoStack.length} onclick={redo} title="Redo (Ctrl+Y)">↷<small>CTRL Y</small></button></div><div class="file-actions" aria-label="Project files"><button onclick={openSvg} title="Import SVG"><span>↗</span><small>SVG</small></button><button onclick={openProject} title="Open .astd project (Ctrl+O)"><span>⌁</span><small>OPEN</small></button><button disabled={!sourceSvg} onclick={() => saveProject(false)} title="Save .astd project (Ctrl+S)"><span>▣</span><small>SAVE</small></button><button disabled={!sourceSvg} onclick={() => saveProject(true)} title="Save project as (Ctrl+Shift+S)"><span>＋</span><small>AS</small></button></div><button class="button primary" disabled={!sourceSvg} onclick={exportPng}><span>↓</span> Export PNG</button></div>
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
        <div class="rig-tools"><button disabled={!sourceSvg || rigEditMode !== "setup"} onclick={addBone}>＋ ADD {selectedBone ? "CHILD" : "ROOT"} BONE</button><small>{rigEditMode === "setup" ? (selectedGroup ? `AUTO-BIND: ${selectedGroup.label}` : "SELECT A GROUP TO AUTO-BIND") : "SWITCH TO SETUP TO EDIT THE RIG"}</small></div>
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
        <div class="zoom-controls"><button disabled={!viewMode} onclick={() => (zoom = Math.max(0.5, zoom - 0.1))}>−</button><span>{Math.round(zoom * 100)}%</span><button disabled={!viewMode} onclick={() => (zoom = Math.min(2, zoom + 0.1))}>+</button></div>
      </div>
      <div class="tool-optionsbar">
        <div class="active-tool-readout"><span>{viewMode === null ? "▦" : viewMode === "rig" ? "⌘" : activeTool === "move" ? "✥" : activeTool === "rotate" ? "↻" : "⌗"}</span><strong>{viewMode === null ? "PIXEL OUTPUT" : viewMode === "rig" ? "SMART BONE" : activeTool.toUpperCase()}</strong><small>{viewMode === null ? "SOLO PREVIEW" : viewMode === "rig" ? "POSITION-SENSITIVE" : activeTool === "move" ? "DRAG SELECTION" : activeTool === "rotate" ? "DRAG AROUND PIVOT" : "DRAG TO RESIZE"}</small></div>
        {#if viewMode === "rig"}<div class="smart-gesture-legend"><span><i class="move-mark">✥</i> MIDDLE · MOVE</span><span><i class="rotate-mark">↻</i> SMALL END · ROTATE</span><span><i class="scale-mark">↔</i> END RING · RESIZE</span></div>{:else if viewMode === null}<div class="tool-hint">CLICK VECTOR OR RIG TO DOCK IT BESIDE PIXEL</div>{:else if activeTool === "scale"}<div class="transform-options"><button class:active={lockRatio} onclick={() => { lockRatio = !lockRatio; if (lockRatio) preserveArea = false; }}><span>⛓</span> LOCK RATIO</button><button class:active={preserveArea} onclick={() => { preserveArea = !preserveArea; if (preserveArea) lockRatio = false; }}><span>◫</span> KEEP AREA</button></div>{:else}<div class="tool-hint">{activeTool === "move" ? "SHIFT + ARROWS · 10 UNITS" : "PIVOT-CENTERED · NON-DESTRUCTIVE"}</div>{/if}
        <div class="options-spacer"></div>
        {#if viewMode === "rig"}<div class="rig-mode-switch"><span>RIG MODE</span><button class:active={rigEditMode === "setup"} onclick={() => setRigEditMode("setup")}><b>01</b> SETUP</button><button class:active={rigEditMode === "pose"} disabled={!activePose} onclick={() => setRigEditMode("pose")}><b>02</b> POSE</button></div>{/if}
      </div>
      <div class="stage" class:split-view={pixelVisible && viewMode !== null} class:pixel-only={pixelVisible && viewMode === null}>
        <div class="stage-grid"></div><div class="axis horizontal"></div><div class="axis vertical"></div>
        <div class="viewport-pane primary-viewport" class:pane-suppressed={viewMode === null}>
          <div class="pane-label"><span>{viewMode === "rig" ? "RIG" : "VECTOR"}</span><small>LIVE WORKSPACE</small></div>
          <nav class="tool-rail" aria-label="Transform tools">
            {#if viewMode === "rig"}<button class="active smart-tool" title="Smart bone transform"><span>⌘</span><small>AUTO</small></button>{:else}<button class:active={activeTool === "move"} onclick={() => (activeTool = "move")} title="Move tool (V)"><span>✥</span><small>V</small></button>
            <button class:active={activeTool === "rotate"} onclick={() => (activeTool = "rotate")} title="Rotate tool (R)"><span>↻</span><small>R</small></button>
            <button class:active={activeTool === "scale"} onclick={() => (activeTool = "scale")} title="Resize tool (S)"><span>⌗</span><small>S</small></button>{/if}
            <i></i><div class="tool-rail-mode">{viewMode === "rig" ? (rigEditMode === "setup" ? "SET" : "POSE") : "SVG"}</div>
          </nav>
          <div class={`artboard-wrap tool-${activeTool}`} style={`--zoom:${zoom};--art-ratio:${viewBox[2] / viewBox[3]}`} class:rig-mode={viewMode === "rig"}>
            <div class="artboard-shadow"></div>
            <div bind:this={svgHost} class="svg-host" role="application" aria-label="SVG pose viewport" onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={pointerUp}></div>
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
          <div class="pane-label pixel-label"><span>PIXEL</span><small>{aiPixelFilter ? `LOCAL AI · ${aiPaletteSize}C` : "EXACT PREVIEW"}</small></div>
          <div class="pixel-preview" style={`aspect-ratio:${outputWidth}/${outputHeight}`}><canvas bind:this={previewCanvas} aria-label="Pixel-art preview"></canvas><div class="pixel-badge">{aiPixelFilter ? `AI ${aiPaletteSize}C` : antiAlias === 0 ? "HARD ALPHA" : `EDGE AA ${antiAlias}%`} · {resizeMode === "contain" ? "FIT CENTER" : "STRETCH"}</div></div>
        </div>
        {#if !sourceSvg}<button class="drop-target" onclick={openSvg}><span class="drop-icon">＋</span><strong>LOAD YOUR VECTOR</strong><p>SVG groups become poseable layers.</p><small>OPEN .SVG</small></button>{/if}
      </div>
      <div class="statusbar"><span class="status-light"></span><span>{status}</span><span class="status-spacer"></span><span>{dirty ? "PROJECT MODIFIED · CTRL S" : projectPath ? "PROJECT SAVED" : "LOCAL RECOVERY ON"}</span><span class="separator">/</span><span>{canvasBackend}</span><span class="separator">/</span><span>{wasmReady ? "RUST CORE ONLINE" : "CORE FALLBACK"}</span></div>
    </section>

    <aside class="panel inspector-panel">
      <div class="panel-heading"><div><span class="eyebrow">SELECTION</span><h2>{viewMode === "rig" ? "Bone" : "Transform"}</h2></div>{#if viewMode === "rig"}<button class="reset" disabled={!selectedBone || (rigEditMode === "pose" && !activePose)} onclick={resetBoneRotation}>{rigEditMode === "setup" ? "RESET PLACEMENT" : "ZERO POSE"}</button>{:else}<button class="reset" disabled={!canEdit || !selectedGroupKey} onclick={resetSelected}>RESET</button>{/if}</div>
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
        {@const transform = currentTransform(selectedGroup.key)}
        <div class="control-section" class:disabled={!activePose}><div class="section-label"><span>POSITION</span><small>SVG UNITS</small></div><div class="control-grid"><label><span>X</span><input disabled={!activePose} type="number" step="1" value={transform.x.toFixed(2)} oninput={(event) => changeTransform("x", event)} /></label><label><span>Y</span><input disabled={!activePose} type="number" step="1" value={transform.y.toFixed(2)} oninput={(event) => changeTransform("y", event)} /></label></div></div>
        <div class="control-section" class:disabled={!activePose}><div class="section-label"><span>ROTATION</span><small>DEGREES</small></div><label class="wide-control"><span>R</span><input disabled={!activePose} type="number" step="1" value={transform.rotation.toFixed(2)} oninput={(event) => changeTransform("rotation", event)} /></label></div>
        <div class="control-section" class:disabled={!activePose}><div class="section-label"><span>SCALE</span><small>LOCAL</small></div><div class="control-grid"><label><span>W</span><input disabled={!activePose} type="number" min="0.01" step="0.05" value={transform.scaleX.toFixed(3)} oninput={(event) => changeTransform("scaleX", event)} /></label><label><span>H</span><input disabled={!activePose} type="number" min="0.01" step="0.05" value={transform.scaleY.toFixed(3)} oninput={(event) => changeTransform("scaleY", event)} /></label></div></div>
      {:else}<div class="empty-panel compact"><span class="empty-glyph">⌖</span><strong>No selection</strong><p>Select an SVG group or bone.</p></div>{/if}
      <div class="export-panel">
        <div class="section-label"><span>PIXEL OUTPUT</span><small>PNG</small></div>
        <div class="resolution-control"><label><span>W</span><input type="number" min="1" max="16384" bind:value={outputWidth} onchange={() => { dirty = true; schedulePreview(); schedulePersist(); }} /></label><span class="times">×</span><label><span>H</span><input type="number" min="1" max="16384" bind:value={outputHeight} onchange={() => { dirty = true; schedulePreview(); schedulePersist(); }} /></label></div>
        <div class="pixel-option"><div class="option-copy"><span>EDGE ANTIALIAS</span><strong>{antiAlias === 0 ? "0 · BINARY ALPHA" : `${antiAlias}%`}</strong></div><input aria-label="Edge antialias" type="range" min="0" max="100" step="1" bind:value={antiAlias} oninput={() => { dirty = true; schedulePreview(); schedulePersist(); }} /></div>
        <label class="select-control pixel-fit"><span>↔</span><select bind:value={resizeMode} onchange={() => { dirty = true; schedulePreview(); schedulePersist(); }}><option value="contain">FIT RATIO · CENTERED</option><option value="stretch">STRETCH TO OUTPUT</option></select></label>
        <p class="option-note">At 0, every visible edge pixel is fully opaque and every empty pixel is fully transparent—no partial alpha.</p>
        <div class:active={aiPixelFilter} class="ai-filter-card">
          <label class="ai-toggle"><input type="checkbox" bind:checked={aiPixelFilter} disabled={!desktopRuntime} onchange={() => { dirty = true; schedulePreview(); schedulePersist(); }} /><span class="toggle-track"><i></i></span><span><strong>OFFLINE PIXEL AI</strong><small>{desktopRuntime ? "LOCAL · NO NETWORK" : "DESKTOP APP ONLY"}</small></span></label>
          <div class="ai-palette" class:disabled={!aiPixelFilter}><div class="option-copy"><span>LEARNED PALETTE</span><strong>{aiPaletteSize} COLORS</strong></div><input aria-label="AI palette colors" disabled={!aiPixelFilter} type="range" min="2" max="64" step="1" bind:value={aiPaletteSize} oninput={() => { dirty = true; schedulePreview(); schedulePersist(); }} /></div>
          <p>The local NumPy model learns the asset's palette, hardens alpha, and removes isolated color noise. No files leave this computer.</p>
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
      <div class="playback-control"><button class:playing={isPlaying} disabled={!sourceSvg || poses.length === 0} onclick={togglePlayback}><span>{isPlaying ? "■" : "▶"}</span>{isPlaying ? "STOP" : "PLAY POSES"}</button><select aria-label="Playback speed" value={playbackFps} onchange={changePlaybackFps}><option value="1">1 FPS</option><option value="2">2 FPS</option><option value="4">4 FPS</option><option value="8">8 FPS</option></select></div>
      <small class="frame-readout">{poses.length} POSE{poses.length === 1 ? "" : "S"} · {frameCount} EXPORT FRAME{frameCount === 1 ? "" : "S"}</small>
      {#if activePose}<input aria-label="Pose name" value={activePose.name} onchange={renamePose} /><button onclick={duplicatePose}>DUPLICATE</button>{:else}<span>REST PREVIEW · NOT EXPORTED</span>{/if}
    </div>
  </footer>
</main>
