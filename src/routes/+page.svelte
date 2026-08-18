<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { open, save } from "@tauri-apps/plugin-dialog";
  import { readTextFile } from "@tauri-apps/plugin-fs";
  import initStudioCore, { transform_matrix } from "$lib/wasm/studio_core.js";
  import { createPose, identityBoneTransform, identityTransform, type Bone, type BonePoseTransform, type GroupTransform, type PixelResizeMode, type Pose, type SvgGroup } from "$lib/editor/model";
  import { prepareSvg, selectWrapper, serializeForExport, setWrapperMatrix } from "$lib/editor/svg";
  import { loadCanvasKit, rasterizeSvg, renderPixelPreview } from "$lib/editor/pixel-preview";
  import { boneDepth, boneGroupMatrices, boneWorldMap, invertMatrix, multiplyMatrix, wouldCreateCycle, type Matrix } from "$lib/editor/rig";
  import "./studio.css";

  type EditorTool = "move" | "rotate" | "scale";
  type RigEditMode = "setup" | "pose";
  type Session = { sourceSvg: string; fileName: string; poses: Pose[]; bones: Bone[]; activePoseId: string; outputWidth: number; outputHeight: number; antiAlias: number; resizeMode: PixelResizeMode; rigEditMode?: RigEditMode };
  type DragState = { pointerId: number; key: string; startPoint: DOMPoint; startTransform: GroupTransform; inverse: DOMMatrix; pivot: { x: number; y: number }; startAngle: number; startDistance: number; startDx: number; startDy: number };
  type BoneDragState = { pointerId: number; boneId: string; inverse: DOMMatrix; startPoint: DOMPoint; startBone: Bone; startPose: BonePoseTransform; startAngle: number; startDistance: number };

  let svgHost: HTMLDivElement;
  let previewCanvas: HTMLCanvasElement;
  let rigSvg = $state<SVGSVGElement>();
  let fileInput: HTMLInputElement;
  let sourceSvg = $state("");
  let fileName = $state("No source loaded");
  let groups = $state<SvgGroup[]>([]);
  let poses = $state<Pose[]>([]);
  let bones = $state<Bone[]>([]);
  let activePoseId = $state("rest");
  let selectedGroupKey = $state<string | null>(null);
  let selectedBoneId = $state<string | null>(null);
  let outputWidth = $state(64);
  let outputHeight = $state(64);
  let antiAlias = $state(0);
  let resizeMode = $state<PixelResizeMode>("contain");
  let activeTool = $state<EditorTool>("move");
  let lockRatio = $state(true);
  let preserveArea = $state(false);
  let rigEditMode = $state<RigEditMode>("setup");
  let viewMode = $state<"vector" | "rig" | "pixel">("vector");
  let leftMode = $state<"groups" | "rig">("groups");
  let viewBox = $state<[number, number, number, number]>([0, 0, 512, 512]);
  let zoom = $state(1);
  let status = $state("Ready for an SVG");
  let warnings = $state<string[]>([]);
  let canvasBackend = $state("CanvasKit loading");
  let wasmReady = $state(false);
  let dirty = $state(false);
  let drag: DragState | null = null;
  let boneDrag: BoneDragState | null = null;
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let setupFrozenMatrices: Record<string, Matrix> = {};
  const pivots: Record<string, { x: number; y: number }> = {};

  const activePose = $derived(poses.find((pose) => pose.id === activePoseId) ?? null);
  const selectedGroup = $derived(groups.find((group) => group.key === selectedGroupKey) ?? null);
  const selectedBone = $derived(bones.find((bone) => bone.id === selectedBoneId) ?? null);
  const boneWorlds = $derived(boneWorldMap(bones, rigEditMode === "pose" ? activePose?.boneTransforms ?? {} : {}));
  const canEdit = $derived(Boolean(sourceSvg && activePose));

  onMount(async () => {
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
      poses = (session.poses ?? []).map((pose) => {
        const legacy = pose as Pose & { boneRotations?: Record<string, number> };
        const migrated = legacy.boneTransforms ?? Object.fromEntries(
          Object.entries(legacy.boneRotations ?? {}).map(([id, rotation]) => [id, { ...identityBoneTransform(), rotation }]),
        );
        return { ...pose, boneTransforms: migrated };
      });
      bones = session.bones ?? [];
      activePoseId = poses.some((pose) => pose.id === session.activePoseId) ? session.activePoseId : "rest";
      outputWidth = session.outputWidth || 64;
      outputHeight = session.outputHeight || 64;
      antiAlias = Number.isFinite(session.antiAlias) ? session.antiAlias : 0;
      resizeMode = session.resizeMode === "stretch" ? "stretch" : "contain";
      rigEditMode = session.rigEditMode === "pose" ? "pose" : "setup";
      requestAnimationFrame(() => { if (rigEditMode === "setup") setupFrozenMatrices = calculatedGroupMatrices(); applyAllTransforms(); });
      status = `Restored ${session.fileName}`;
    } catch (error) { console.warn("Unable to restore prior session", error); }
  });

  function isTauri() { return "__TAURI_INTERNALS__" in window; }
  function currentTransform(key: string): GroupTransform {
    const pivot = pivots[key] ?? { x: 0, y: 0 };
    return activePose?.transforms[key] ?? { ...identityTransform(), pivotX: pivot.x, pivotY: pivot.y };
  }
  function matrixFor(transform: GroupTransform): number[] {
    if (wasmReady) return Array.from(transform_matrix(transform.x, transform.y, transform.rotation, transform.scaleX, transform.scaleY, transform.pivotX, transform.pivotY));
    const radians = transform.rotation * Math.PI / 180;
    const cosine = Math.cos(radians), sine = Math.sin(radians);
    const a = cosine * transform.scaleX, b = sine * transform.scaleX, c = -sine * transform.scaleY, d = cosine * transform.scaleY;
    return [a, b, c, d, transform.x + transform.pivotX - a * transform.pivotX - c * transform.pivotY, transform.y + transform.pivotY - b * transform.pivotX - d * transform.pivotY];
  }
  function calculatedGroupMatrices(): Record<string, Matrix> {
    const rigMatrices = boneGroupMatrices(bones, activePose?.boneTransforms ?? {});
    return Object.fromEntries(groups.map((group) => {
      const direct = matrixFor(currentTransform(group.key)) as Matrix;
      return [group.key, rigMatrices[group.key] ? multiplyMatrix(rigMatrices[group.key], direct) : direct];
    }));
  }
  function applyAllTransforms() {
    if (!svgHost) return;
    const calculated = calculatedGroupMatrices();
    const freezeRig = viewMode === "rig" && rigEditMode === "setup";
    for (const group of groups) setWrapperMatrix(svgHost, group.key, freezeRig && setupFrozenMatrices[group.key] ? setupFrozenMatrices[group.key] : calculated[group.key]);
    selectWrapper(svgHost, selectedGroupKey);
    schedulePreview();
  }
  function setRigEditMode(mode: RigEditMode) {
    if (mode === "pose" && !activePose) { status = "Create a pose before using Follow Artwork mode."; return; }
    if (mode === "setup") setupFrozenMatrices = calculatedGroupMatrices();
    rigEditMode = mode; applyAllTransforms(); schedulePersist();
    status = mode === "setup" ? "Rig Setup: edit guides without moving artwork" : "Follow Artwork: bound groups follow bone tools";
  }
  function showRig() {
    if (rigEditMode === "setup") setupFrozenMatrices = calculatedGroupMatrices();
    viewMode = "rig"; leftMode = "rig"; applyAllTransforms();
  }
  function collectPivots() {
    for (const group of groups) {
      const wrapper = svgHost.querySelector(`[data-studio-group="${CSS.escape(group.key)}"]`) as SVGGElement | null;
      if (!wrapper) continue;
      try { const box = wrapper.getBBox(); pivots[group.key] = { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }
      catch { pivots[group.key] = { x: 0, y: 0 }; }
    }
  }
  async function loadSvgSource(svg: string, name: string, persist = true) {
    const prepared = prepareSvg(svg);
    sourceSvg = svg; fileName = name; groups = prepared.groups; warnings = prepared.warnings; viewBox = prepared.viewBox;
    selectedGroupKey = groups[0]?.key ?? null; selectedBoneId = null; poses = []; bones = []; activePoseId = "rest";
    svgHost.innerHTML = prepared.markup;
    requestAnimationFrame(() => { collectPivots(); applyAllTransforms(); });
    status = `${groups.length} editable group${groups.length === 1 ? "" : "s"} indexed`;
    dirty = false;
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
  function selectGroup(key: string) { selectedGroupKey = key; selectWrapper(svgHost, key); }
  function addPose() {
    if (!sourceSvg) return;
    const pose = createPose(`Pose ${String(poses.length + 1).padStart(2, "0")}`, activePose?.transforms ?? {}, activePose?.boneTransforms ?? {});
    poses = [...poses, pose]; activePoseId = pose.id; dirty = false; applyAllTransforms(); schedulePersist();
    status = `${pose.name} created as an independent pose`;
  }
  function duplicatePose() {
    if (!activePose) return;
    const pose = createPose(`${activePose.name} copy`, activePose.transforms, activePose.boneTransforms);
    poses = [...poses, pose]; activePoseId = pose.id; dirty = false; applyAllTransforms(); schedulePersist();
  }
  function deletePose(pose: Pose) {
    poses = poses.filter((item) => item.id !== pose.id);
    if (activePoseId === pose.id) activePoseId = "rest";
    dirty = false; applyAllTransforms(); schedulePersist();
  }
  function choosePose(id: string) {
    activePoseId = id; dirty = false;
    if (id === "rest" && rigEditMode === "pose") rigEditMode = "setup";
    requestAnimationFrame(() => { if (viewMode === "rig" && rigEditMode === "setup") setupFrozenMatrices = calculatedGroupMatrices(); applyAllTransforms(); });
  }
  function renamePose(event: Event) {
    if (!activePose) return;
    const name = (event.currentTarget as HTMLInputElement).value.trim();
    if (name) { poses = poses.map((pose) => pose.id === activePose.id ? { ...pose, name } : pose); schedulePersist(); }
  }
  function updateTransform(key: string, next: GroupTransform, preview = true) {
    if (!activePose) return;
    poses = poses.map((pose) => pose.id === activePose.id ? { ...pose, transforms: { ...pose.transforms, [key]: { ...next } } } : pose);
    applyAllTransforms(); dirty = true;
    if (preview) schedulePreview();
    schedulePersist();
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
    if (viewMode !== "rig") showRig(); else leftMode = "rig";
  }
  function addBone() {
    if (!sourceSvg) return;
    const parent = bones.find((bone) => bone.id === selectedBoneId) ?? null;
    const pivot = selectedGroupKey ? pivots[selectedGroupKey] : null;
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
    bones = [...bones.map((item) => item.groupKey === bone.groupKey ? { ...item, groupKey: null } : item), bone];
    selectedBoneId = bone.id; showRig();
    applyAllTransforms(); schedulePersist();
    status = parent ? `${bone.name} added as a child of ${parent.name}` : `${bone.name} root created`;
  }
  function updateBone(next: Bone) {
    bones = bones.map((bone) => bone.id === next.id ? { ...next } : bone);
    applyAllTransforms(); schedulePersist();
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
    const groupKey = (event.currentTarget as HTMLSelectElement).value || null;
    bones = bones.map((bone) => bone.id === selectedBone.id
      ? { ...bone, groupKey }
      : groupKey && bone.groupKey === groupKey ? { ...bone, groupKey: null } : bone);
    applyAllTransforms(); schedulePersist();
    status = groupKey ? `${selectedBone.name} bound to ${groups.find((group) => group.key === groupKey)?.label}` : `${selectedBone.name} unbound`;
  }
  function deleteBone() {
    if (!selectedBone) return;
    const removed = new Set([selectedBone.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const bone of bones) if (bone.parentId && removed.has(bone.parentId) && !removed.has(bone.id)) { removed.add(bone.id); changed = true; }
    }
    bones = bones.filter((bone) => !removed.has(bone.id));
    poses = poses.map((pose) => ({ ...pose, boneTransforms: Object.fromEntries(Object.entries(pose.boneTransforms ?? {}).filter(([id]) => !removed.has(id))) }));
    selectedBoneId = null; applyAllTransforms(); schedulePersist();
    status = `${removed.size} bone${removed.size === 1 ? "" : "s"} removed`;
  }
  function currentBoneTransform(id: string): BonePoseTransform { return activePose?.boneTransforms[id] ?? identityBoneTransform(); }
  function updateBonePose(id: string, transform: BonePoseTransform, preview = true) {
    if (!activePose) return;
    poses = poses.map((pose) => pose.id === activePose.id ? { ...pose, boneTransforms: { ...(pose.boneTransforms ?? {}), [id]: { ...transform } } } : pose);
    applyAllTransforms(); dirty = true;
    if (preview) schedulePreview();
    schedulePersist();
  }
  function changeBoneRotation(event: Event) {
    if (!selectedBone || !activePose) return;
    const rotation = Number((event.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(rotation)) updateBonePose(selectedBone.id, { ...currentBoneTransform(selectedBone.id), rotation });
  }
  function resetBoneRotation() {
    if (selectedBone && activePose) updateBonePose(selectedBone.id, identityBoneTransform());
  }
  function changeBonePoseNumber(field: keyof BonePoseTransform, event: Event) {
    if (!selectedBone || !activePose) return;
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    updateBonePose(selectedBone.id, { ...currentBoneTransform(selectedBone.id), [field]: field.startsWith("scale") ? Math.max(0.02, value) : value });
  }
  function pointWithMatrix(matrix: Matrix, x: number, y: number) {
    return { x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] };
  }
  function vectorWithMatrix(matrix: Matrix, x: number, y: number) {
    return { x: matrix[0] * x + matrix[2] * y, y: matrix[1] * x + matrix[3] * y };
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
  function bonePointerDown(event: PointerEvent, boneId: string) {
    selectBone(boneId);
    if (rigEditMode === "pose" && !activePose) { status = "Create a pose before using Follow Artwork mode."; return; }
    const inverse = rigSvg?.getScreenCTM()?.inverse();
    if (!inverse) return;
    const bone = bones.find((item) => item.id === boneId);
    const world = boneWorlds[boneId];
    if (!bone || !world) return;
    const startPoint = new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse);
    boneDrag = {
      pointerId: event.pointerId,
      boneId,
      inverse,
      startPoint,
      startBone: { ...bone },
      startPose: { ...currentBoneTransform(boneId) },
      startAngle: Math.atan2(startPoint.y - world.startY, startPoint.x - world.startX),
      startDistance: Math.max(1, Math.hypot(startPoint.x - world.startX, startPoint.y - world.startY)),
    };
    rigSvg?.setPointerCapture(event.pointerId);
    event.preventDefault(); event.stopPropagation();
  }
  function bonePointerMove(event: PointerEvent) {
    if (!boneDrag || boneDrag.pointerId !== event.pointerId) return;
    const bone = bones.find((item) => item.id === boneDrag?.boneId);
    const world = bone ? boneWorlds[bone.id] : null;
    if (!bone || !world) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(boneDrag.inverse);
    if (activeTool === "move") {
      const parentMatrix = bone.parentId ? boneWorlds[bone.parentId]?.matrix : null;
      const localDelta = parentMatrix
        ? vectorWithMatrix(invertMatrix(parentMatrix), point.x - boneDrag.startPoint.x, point.y - boneDrag.startPoint.y)
        : { x: point.x - boneDrag.startPoint.x, y: point.y - boneDrag.startPoint.y };
      if (rigEditMode === "setup") updateBone({ ...boneDrag.startBone, x: boneDrag.startBone.x + localDelta.x, y: boneDrag.startBone.y + localDelta.y });
      else updateBonePose(bone.id, { ...boneDrag.startPose, x: boneDrag.startPose.x + localDelta.x, y: boneDrag.startPose.y + localDelta.y }, false);
    } else if (activeTool === "rotate") {
      let delta = (Math.atan2(point.y - world.startY, point.x - world.startX) - boneDrag.startAngle) * 180 / Math.PI;
      while (delta > 180) delta -= 360;
      while (delta <= -180) delta += 360;
      if (rigEditMode === "setup") updateBone({ ...boneDrag.startBone, restRotation: boneDrag.startBone.restRotation + delta });
      else updateBonePose(bone.id, { ...boneDrag.startPose, rotation: boneDrag.startPose.rotation + delta }, false);
    } else {
      const distance = Math.hypot(point.x - world.startX, point.y - world.startY);
      const factor = Math.max(0.02, 1 + (distance - boneDrag.startDistance) / Math.max(12, boneDrag.startBone.length));
      if (rigEditMode === "setup") updateBone({ ...boneDrag.startBone, length: Math.max(1, boneDrag.startBone.length * factor) });
      else {
        const pair = scalePair(factor, 1 + (point.y - boneDrag.startPoint.y) / Math.max(20, boneDrag.startBone.length), boneDrag.startPose.scaleX, boneDrag.startPose.scaleY);
        updateBonePose(bone.id, { ...boneDrag.startPose, scaleX: pair.x, scaleY: pair.y }, false);
      }
    }
  }
  function bonePointerUp(event: PointerEvent) {
    if (!boneDrag || boneDrag.pointerId !== event.pointerId) return;
    boneDrag = null; schedulePreview(); status = rigEditMode === "setup" ? "Rig guide updated; artwork unchanged" : `${activePose?.name ?? "Pose"} rig transform updated`;
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
    const startPoint = new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse);
    const sourcePivot = pivots[key] ?? { x: 0, y: 0 };
    const pivot = pointWithMatrix(calculatedGroupMatrices()[key], sourcePivot.x, sourcePivot.y);
    drag = {
      pointerId: event.pointerId, key, startPoint, startTransform: { ...currentTransform(key) }, inverse, pivot,
      startAngle: Math.atan2(startPoint.y - pivot.y, startPoint.x - pivot.x),
      startDistance: Math.max(1, Math.hypot(startPoint.x - pivot.x, startPoint.y - pivot.y)),
      startDx: startPoint.x - pivot.x,
      startDy: startPoint.y - pivot.y,
    };
    svgHost.setPointerCapture(event.pointerId); event.preventDefault();
  }
  function pointerMove(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(drag.inverse);
    if (activeTool === "move") {
      updateTransform(drag.key, { ...drag.startTransform, x: drag.startTransform.x + point.x - drag.startPoint.x, y: drag.startTransform.y + point.y - drag.startPoint.y }, false);
    } else if (activeTool === "rotate") {
      const angle = Math.atan2(point.y - drag.pivot.y, point.x - drag.pivot.x);
      updateTransform(drag.key, { ...drag.startTransform, rotation: drag.startTransform.rotation + (angle - drag.startAngle) * 180 / Math.PI }, false);
    } else {
      const basis = Math.max(20, Math.min(viewBox[2], viewBox[3]) * 0.25);
      const factorX = 1 + (point.x - drag.startPoint.x) / basis;
      const factorY = 1 + (point.y - drag.startPoint.y) / basis;
      const pair = scalePair(factorX, factorY, drag.startTransform.scaleX, drag.startTransform.scaleY);
      updateTransform(drag.key, { ...drag.startTransform, scaleX: pair.x, scaleY: pair.y }, false);
    }
  }
  function pointerUp(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null; schedulePreview(); status = `${activePose?.name ?? "Pose"} updated`;
  }
  function keyboardHandler(event: KeyboardEvent) {
    if ((event.target as HTMLElement | null)?.matches("input,select,textarea")) return;
    const key = event.key.toLowerCase();
    if (key === "v") { activeTool = "move"; return; }
    if (key === "r") { activeTool = "rotate"; return; }
    if (key === "s") { activeTool = "scale"; return; }
    if (!event.key.startsWith("Arrow")) return;
    const amount = event.shiftKey ? 10 : 1;
    if (viewMode === "rig" && selectedBone) {
      if (rigEditMode === "setup") {
        const next = { ...selectedBone };
        if (event.key === "ArrowLeft") next.x -= amount;
        if (event.key === "ArrowRight") next.x += amount;
        if (event.key === "ArrowUp") next.y -= amount;
        if (event.key === "ArrowDown") next.y += amount;
        updateBone(next);
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
  async function refreshPreview() {
    if (!svgHost || !previewCanvas || !sourceSvg) return;
    try {
      const backend = await renderPixelPreview(
        serializeForExport(svgHost),
        Math.max(1, Math.round(outputWidth)),
        Math.max(1, Math.round(outputHeight)),
        previewCanvas,
        { antiAlias, resizeMode },
      );
      canvasBackend = backend === "canvaskit" ? "CanvasKit · Skia/WASM" : "Canvas 2D fallback";
    } catch (error) { console.error(error); }
  }
  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => localStorage.setItem("asset-studio:last-session", JSON.stringify({ sourceSvg, fileName, poses, bones, activePoseId, outputWidth, outputHeight, antiAlias, resizeMode, rigEditMode } satisfies Session)), 250);
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
        await invoke("export_png", { svg, path, width: Math.round(outputWidth), height: Math.round(outputHeight), antiAlias: Math.round(antiAlias), resizeMode });
        status = `Exported ${path.split(/[\\/]/).pop()}`;
      } else { await exportPngInBrowser(svg, defaultName); status = `Exported ${defaultName}`; }
      dirty = false;
    } catch (error) { status = error instanceof Error ? error.message : String(error); }
  }
</script>

<svelte:window onkeydown={keyboardHandler} />
<main class="studio-shell">
  <input bind:this={fileInput} class="hidden-input" type="file" accept="image/svg+xml,.svg" onchange={receiveFile} />
  <header class="topbar">
    <div class="brand-block"><span class="brand-mark">AS</span><div><strong>ASSET/STUDIO</strong><small>VECTOR POSE LAB</small></div></div>
    <div class="document-pill" title={fileName}><span class:live={Boolean(sourceSvg)}></span><div><small>SOURCE · READ ONLY</small><strong>{fileName}</strong></div></div>
    <div class="top-actions"><button class="button ghost" onclick={openSvg}><span>↗</span> Open SVG</button><button class="button primary" disabled={!sourceSvg} onclick={exportPng}><span>↓</span> Export PNG</button></div>
  </header>

  <section class="workspace">
    <aside class="panel layers-panel">
      <div class="panel-heading"><div><span class="eyebrow">DOCUMENT</span><h2>{leftMode === "groups" ? "SVG Groups" : "Bone Rig"}</h2></div><span class="count">{leftMode === "groups" ? groups.length : bones.length}</span></div>
      <div class="panel-tabs"><button class:active={leftMode === "groups"} onclick={() => (leftMode = "groups")}>GROUPS</button><button class:active={leftMode === "rig"} onclick={() => (leftMode = "rig")}>RIG</button></div>
      {#if leftMode === "groups"}
        {#if groups.length}
          <div class="group-list">
            {#each groups as group, index}
              <button class:selected={selectedGroupKey === group.key} class="group-row" style={`--depth:${group.depth}`} onclick={() => selectGroup(group.key)}>
                <span class="disclosure">{group.parentKey ? "└" : "◆"}</span><span class="group-icon">G</span>
                <span class="group-copy"><strong>{group.label}</strong><small>{group.sourceId ? `#${group.sourceId}` : `GROUP ${String(index + 1).padStart(2, "0")}`}</small></span>
              </button>
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
        <div class="segmented"><button class:active={viewMode === "vector"} onclick={() => { viewMode = "vector"; applyAllTransforms(); }}>VECTOR</button><button class:active={viewMode === "rig"} onclick={showRig}>RIG</button><button class:active={viewMode === "pixel"} onclick={() => { viewMode = "pixel"; applyAllTransforms(); schedulePreview(); }}>PIXEL</button></div>
        <div class="stage-meta"><span>{activePose?.name ?? "REST / SOURCE"}</span><i></i><span>{viewMode === "pixel" ? `${outputWidth} × ${outputHeight} PX` : `${Math.round(zoom * 100)}%`}</span></div>
        <div class="zoom-controls"><button onclick={() => (zoom = Math.max(0.5, zoom - 0.1))}>−</button><span>{Math.round(zoom * 100)}%</span><button onclick={() => (zoom = Math.min(2, zoom + 0.1))}>+</button></div>
      </div>
      <div class="tool-optionsbar">
        <div class="active-tool-readout"><span>{activeTool === "move" ? "✥" : activeTool === "rotate" ? "↻" : "⌗"}</span><strong>{activeTool.toUpperCase()}</strong><small>{activeTool === "move" ? "DRAG SELECTION" : activeTool === "rotate" ? "DRAG AROUND PIVOT" : "DRAG TO RESIZE"}</small></div>
        {#if activeTool === "scale"}<div class="transform-options"><button class:active={lockRatio} onclick={() => { lockRatio = !lockRatio; if (lockRatio) preserveArea = false; }}><span>⛓</span> LOCK RATIO</button><button class:active={preserveArea} onclick={() => { preserveArea = !preserveArea; if (preserveArea) lockRatio = false; }}><span>◫</span> KEEP AREA</button></div>{:else}<div class="tool-hint">{activeTool === "move" ? "SHIFT + ARROWS · 10 UNITS" : "PIVOT-CENTERED · NON-DESTRUCTIVE"}</div>{/if}
        <div class="options-spacer"></div>
        {#if viewMode === "rig"}<div class="rig-mode-switch"><span>RIG BEHAVIOR</span><button class:active={rigEditMode === "setup"} onclick={() => setRigEditMode("setup")}><b>01</b> SETUP</button><button class:active={rigEditMode === "pose"} disabled={!activePose} onclick={() => setRigEditMode("pose")}><b>02</b> FOLLOW ARTWORK</button></div>{/if}
      </div>
      <div class="stage" class:pixel-mode={viewMode === "pixel"}>
        <div class="stage-grid"></div><div class="axis horizontal"></div><div class="axis vertical"></div>
        <nav class="tool-rail" class:hidden={viewMode === "pixel"} aria-label="Transform tools">
          <button class:active={activeTool === "move"} onclick={() => (activeTool = "move")} title="Move tool (V)"><span>✥</span><small>V</small></button>
          <button class:active={activeTool === "rotate"} onclick={() => (activeTool = "rotate")} title="Rotate tool (R)"><span>↻</span><small>R</small></button>
          <button class:active={activeTool === "scale"} onclick={() => (activeTool = "scale")} title="Resize tool (S)"><span>⌗</span><small>S</small></button>
          <i></i><div class="tool-rail-mode">{viewMode === "rig" ? (rigEditMode === "setup" ? "SET" : "POSE") : "SVG"}</div>
        </nav>
        <div class={`artboard-wrap tool-${activeTool}`} style={`--zoom:${zoom};--art-ratio:${viewBox[2] / viewBox[3]}`} class:hidden={viewMode === "pixel"} class:rig-mode={viewMode === "rig"}>
          <div class="artboard-shadow"></div>
          <div bind:this={svgHost} class="svg-host" role="application" aria-label="SVG pose viewport" onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={pointerUp}></div>
          {#if viewMode === "rig"}
            <svg bind:this={rigSvg} class="rig-overlay" viewBox={viewBox.join(" ")} preserveAspectRatio="xMidYMid meet" role="application" aria-label="Bone rig overlay" onpointermove={bonePointerMove} onpointerup={bonePointerUp} onpointercancel={bonePointerUp}>
              {#each bones as bone}
                {@const world = boneWorlds[bone.id]}
                {#if world}<g class="bone-shape" class:selected={selectedBoneId === bone.id} role="button" tabindex="0" aria-label={bone.name} onpointerdown={(event) => bonePointerDown(event, bone.id)}>
                  <line class="bone-hit" x1={world.startX} y1={world.startY} x2={world.endX} y2={world.endY}></line>
                  <line class="bone-body" x1={world.startX} y1={world.startY} x2={world.endX} y2={world.endY}></line>
                  <circle class="bone-joint" cx={world.startX} cy={world.startY} r={Math.max(2.5, Math.min(viewBox[2], viewBox[3]) * 0.008)}></circle>
                  <circle class="bone-tip" cx={world.endX} cy={world.endY} r={Math.max(1.8, Math.min(viewBox[2], viewBox[3]) * 0.005)}></circle>
                </g>{/if}
              {/each}
            </svg>
          {/if}
        </div>
        <div class="pixel-preview" class:hidden={viewMode !== "pixel"} style={`aspect-ratio:${outputWidth}/${outputHeight}`}><canvas bind:this={previewCanvas} aria-label="Pixel-art preview"></canvas><div class="pixel-badge">{antiAlias === 0 ? "HARD ALPHA" : `EDGE AA ${antiAlias}%`} · {resizeMode === "contain" ? "FIT CENTER" : "STRETCH"}</div></div>
        {#if !sourceSvg}<button class="drop-target" onclick={openSvg}><span class="drop-icon">＋</span><strong>LOAD YOUR VECTOR</strong><p>SVG groups become poseable layers.</p><small>OPEN .SVG</small></button>{/if}
      </div>
      <div class="statusbar"><span class="status-light"></span><span>{status}</span><span class="status-spacer"></span><span>{dirty ? "UNSAVED POSE CHANGE" : "AUTOSAVED"}</span><span class="separator">/</span><span>{canvasBackend}</span><span class="separator">/</span><span>{wasmReady ? "RUST CORE ONLINE" : "CORE FALLBACK"}</span></div>
    </section>

    <aside class="panel inspector-panel">
      <div class="panel-heading"><div><span class="eyebrow">SELECTION</span><h2>{viewMode === "rig" ? "Bone" : "Transform"}</h2></div>{#if viewMode === "rig"}<button class="reset" disabled={rigEditMode !== "pose" || !activePose || !selectedBone} onclick={resetBoneRotation}>ZERO POSE</button>{:else}<button class="reset" disabled={!canEdit || !selectedGroupKey} onclick={resetSelected}>RESET</button>{/if}</div>
      {#if viewMode === "rig" && selectedBone}
        <div class="selection-card"><span class="selection-chip bone-chip">B</span><div><small>ACTIVE BONE · {rigEditMode === "setup" ? "SETUP" : "FOLLOW ARTWORK"}</small><strong>{selectedBone.name}</strong></div></div>
        <div class:follow={rigEditMode === "pose"} class="rig-behavior-note"><span>{rigEditMode === "setup" ? "01" : "02"}</span><div><strong>{rigEditMode === "setup" ? "Guide-only adjustment" : "Artwork follows the chain"}</strong><small>{rigEditMode === "setup" ? "Move, rotate, or resize the rest rig without moving any SVG group." : "Tool changes are stored in this pose and inherited by bound children."}</small></div></div>
        <div class="control-section" class:disabled={rigEditMode !== "setup"}><div class="section-label"><span>IDENTITY</span><small>RIG DATA</small></div><label class="wide-control text-control"><span>N</span><input disabled={rigEditMode !== "setup"} value={selectedBone.name} onchange={changeBoneName} /></label></div>
        <div class="control-section" class:disabled={rigEditMode !== "setup"}><div class="section-label"><span>HIERARCHY</span><small>PARENT → CHILD</small></div><label class="select-control"><span>P</span><select disabled={rigEditMode !== "setup"} value={selectedBone.parentId ?? ""} onchange={changeBoneParent}><option value="">ROOT</option>{#each bones.filter((bone) => bone.id !== selectedBone.id && !wouldCreateCycle(selectedBone.id, bone.id, bones)) as bone}<option value={bone.id}>{bone.name}</option>{/each}</select></label><label class="select-control"><span>G</span><select disabled={rigEditMode !== "setup"} value={selectedBone.groupKey ?? ""} onchange={changeBoneBinding}><option value="">GUIDE ONLY</option>{#each groups as group}<option value={group.key}>{group.label}</option>{/each}</select></label></div>
        <div class="control-section" class:disabled={rigEditMode !== "setup"}><div class="section-label"><span>REST GUIDE</span><small>LOCAL SPACE</small></div><div class="control-grid"><label><span>X</span><input disabled={rigEditMode !== "setup"} type="number" step="1" value={selectedBone.x.toFixed(2)} oninput={(event) => changeBoneNumber("x", event)} /></label><label><span>Y</span><input disabled={rigEditMode !== "setup"} type="number" step="1" value={selectedBone.y.toFixed(2)} oninput={(event) => changeBoneNumber("y", event)} /></label></div><div class="control-grid second-row"><label><span>L</span><input disabled={rigEditMode !== "setup"} type="number" min="1" step="1" value={selectedBone.length.toFixed(2)} oninput={(event) => changeBoneNumber("length", event)} /></label><label><span>R</span><input disabled={rigEditMode !== "setup"} type="number" step="1" value={selectedBone.restRotation.toFixed(2)} oninput={(event) => changeBoneNumber("restRotation", event)} /></label></div></div>
        {@const bonePose = currentBoneTransform(selectedBone.id)}
        <div class="control-section" class:disabled={rigEditMode !== "pose" || !activePose}><div class="section-label"><span>POSE TRANSFORM</span><small>NON-DESTRUCTIVE</small></div><div class="control-grid"><label><span>X</span><input disabled={rigEditMode !== "pose" || !activePose} type="number" step="1" value={bonePose.x.toFixed(2)} oninput={(event) => changeBonePoseNumber("x", event)} /></label><label><span>Y</span><input disabled={rigEditMode !== "pose" || !activePose} type="number" step="1" value={bonePose.y.toFixed(2)} oninput={(event) => changeBonePoseNumber("y", event)} /></label></div><label class="wide-control second-row"><span>R</span><input disabled={rigEditMode !== "pose" || !activePose} type="number" step="1" value={bonePose.rotation.toFixed(2)} oninput={changeBoneRotation} /></label><div class="control-grid second-row"><label><span>W</span><input disabled={rigEditMode !== "pose" || !activePose} type="number" min="0.02" step="0.05" value={bonePose.scaleX.toFixed(3)} oninput={(event) => changeBonePoseNumber("scaleX", event)} /></label><label><span>H</span><input disabled={rigEditMode !== "pose" || !activePose} type="number" min="0.02" step="0.05" value={bonePose.scaleY.toFixed(3)} oninput={(event) => changeBonePoseNumber("scaleY", event)} /></label></div></div>
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
        <div class="resolution-control"><label><span>W</span><input type="number" min="1" max="16384" bind:value={outputWidth} onchange={() => { schedulePreview(); schedulePersist(); }} /></label><span class="times">×</span><label><span>H</span><input type="number" min="1" max="16384" bind:value={outputHeight} onchange={() => { schedulePreview(); schedulePersist(); }} /></label></div>
        <div class="pixel-option"><div class="option-copy"><span>EDGE ANTIALIAS</span><strong>{antiAlias === 0 ? "0 · BINARY ALPHA" : `${antiAlias}%`}</strong></div><input aria-label="Edge antialias" type="range" min="0" max="100" step="1" bind:value={antiAlias} oninput={() => { schedulePreview(); schedulePersist(); }} /></div>
        <label class="select-control pixel-fit"><span>↔</span><select bind:value={resizeMode} onchange={() => { schedulePreview(); schedulePersist(); }}><option value="contain">FIT RATIO · CENTERED</option><option value="stretch">STRETCH TO OUTPUT</option></select></label>
        <p class="option-note">At 0, every visible edge pixel is fully opaque and every empty pixel is fully transparent—no partial alpha.</p>
        <button class="export-wide" disabled={!sourceSvg} onclick={exportPng}>EXPORT ACTIVE POSE <span>↓</span></button>
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
    <div class="pose-actions">{#if activePose}<input aria-label="Pose name" value={activePose.name} onchange={renamePose} /><button onclick={duplicatePose}>DUPLICATE</button>{:else}<span>Select or create a pose</span>{/if}</div>
  </footer>
</main>
