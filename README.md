# Asset Studio

Asset Studio is a Tauri desktop editor for turning grouped SVG artwork into independent named poses and exporting them as pixel-resolution PNG files.

The imported SVG is treated as immutable. A pose contains only transform, bone, and group-visibility overrides; switching, duplicating, or deleting a pose never modifies the source document or the rest rig.

## Local environment

The reusable toolchain is isolated under `D:\Env\asset-studio`.

```powershell
. D:\Env\asset-studio\activate.ps1
pnpm install
./scripts/setup-pixel-ai.ps1
pnpm tauri dev
```

The activation script selects the project Node, pnpm, Rust, Cargo, WASM target, package store, shared Cargo target directory, and the optional Python environment. The pixel-AI setup installs Pillow and NumPy under `D:\Env\asset-studio`; inference is fully offline and downloads no model weights.

## Validation

```powershell
. D:\Env\asset-studio\activate.ps1
pnpm check
pnpm build
cargo test --manifest-path crates/studio-core/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

## Current workflow

1. Open an SVG containing `<g>` elements.
2. Select a group in the layer panel or on the canvas.
3. Create a pose; the REST/source pose is intentionally locked.
4. Use the Photoshop-style tool rail: **Move** (`V`), **Rotate** (`R`), or **Resize** (`S`). Drag directly on selected artwork or edit the same values numerically.
5. Resize can use **Lock ratio**, free two-axis distortion, or **Keep area**, which inversely scales the second axis to preserve the current pixel area.
6. Open **Rig**, select a group, and add a root bone. Select a bone before adding the next one to create a parent/child chain. The new child auto-binds to the selected group and points toward its center.
7. Bones use a unified smart manipulator: drag the middle to move the whole bone, drag an endpoint or its outside orbit to rotate around the opposite endpoint without changing length, and drag the endpoint ring to resize along the bone axis. The cursor changes to four arrows, curved arrows, or aligned two-way arrows for each zone.
8. **Setup** and **Pose** show the exact same guide placement. Setup is stored as the global rig baseline while every pose stores only its own delta. Arrange guides in Setup with the artwork frozen, then switch to Pose without a skeleton jump or accidental deformation.
   Bone pivots are kept in SVG-root space, so bound groups nested below source `translate`, `rotate`, or non-uniform `scale` transforms still rotate around the visible bone endpoint.
9. Create or duplicate more poses. Every pose owns independent group transforms, bone transforms, and layer visibility. Use the eye beside an SVG group to swap alternate feet, hands, mouths, or other sprite parts for that pose only.
10. Set the pixel resolution, then choose **Fit ratio · centered** or **Stretch to output**.
11. Set **Edge antialias** from 0–100. At 0, alpha is strictly binary (0 or 255); higher values blend toward the renderer's smooth vector edge.
12. Toggle **Pixel** independently from Vector or Rig. Pixel docks beside the active workspace; clicking the active Vector/Rig tab leaves a pixel-only view, while Vector and Rig replace one another.
13. Optionally enable **Offline Pixel AI**. Its competitive-learning model learns a compact palette from the current output, hardens alpha, and removes isolated one-pixel color noise without sending the image anywhere.
14. Use **Play all** to loop through Rest and every named pose at 1, 2, 4, or 8 FPS.
15. Export the active frame, or export Rest plus every pose as a single horizontal PNG tileset. When Pixel AI is enabled, the whole sheet learns one shared palette for frame-to-frame color consistency.
16. Undo document edits with **Ctrl+Z** and redo with **Ctrl+Y** (or **Ctrl+Shift+Z**). A completed pointer drag is stored as one history command.

The most recent source, rest rig, pose, and pixel settings are autosaved locally. A versioned portable `.assetstudio` project archive, palettes, animation timelines, and soft mesh deformation are planned follow-up milestones.
