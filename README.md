# Asset Studio

Asset Studio is a Tauri desktop editor for turning grouped SVG artwork into independent named poses and exporting them as pixel-resolution PNG files.

The imported SVG is treated as immutable. A pose contains only transform overrides and bone rotation deltas; switching, duplicating, or deleting a pose never modifies the source document or the rest rig.

## Local environment

The reusable toolchain is isolated under `D:\Env\asset-studio`.

```powershell
. D:\Env\asset-studio\activate.ps1
pnpm install
pnpm tauri dev
```

The activation script selects the project Node, pnpm, Rust, Cargo, WASM target, package store, and shared Cargo target directory.

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
7. Use **Setup** mode to move, rotate, or lengthen rest guides without changing any SVG group. Use **Follow Artwork** mode to apply Move, Rotate, and Resize as pose transforms; descendants and bound groups inherit the result.
8. Create or duplicate more poses. Every pose owns independent group and bone transforms.
9. Set the pixel resolution, then choose **Fit ratio · centered** or **Stretch to output**.
10. Set **Edge antialias** from 0–100. At 0, alpha is strictly binary (0 or 255); higher values blend toward the renderer's smooth vector edge.
11. Inspect the CanvasKit nearest-neighbor preview and export through the native Rust/resvg PNG pipeline.

The most recent source, rest rig, pose, and pixel settings are autosaved locally. A versioned portable `.assetstudio` project archive, palettes, animation timelines, and soft mesh deformation are planned follow-up milestones.
