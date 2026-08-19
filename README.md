# Asset Studio

Asset Studio is a Tauri desktop editor for turning grouped SVG artwork into independent named poses and exporting them as pixel-resolution PNG files.

The imported SVG is treated as immutable. A pose contains only transform, bone, and group-visibility overrides; switching, duplicating, or deleting a pose never modifies the source document or the rest rig.

## Local environment

The reusable toolchain is isolated under `D:\Env\asset-studio`.

```powershell
. D:\Env\asset-studio\activate.ps1
pnpm install
pnpm tauri dev
```

The activation script selects the project Node, pnpm, Rust, Cargo, WASM target, package store, and shared Cargo target directory. Pixel-art rasterization runs deterministically in Rust and requires no Python environment, model weights, or network access.

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
6. Open **Rig**, select a group, and add a root bone. Select a bone before adding the next one to create a parent/child chain. New bindings preserve the intended bone direction, center it on the group, and inset both endpoints by 8% so the guide remains inside the artwork. Use **Fit to Group** in the bone inspector to repeat that placement later without changing the binding.
7. Bones use a unified smart manipulator. Dragging the middle moves any bone and its descendants without moving its parent. When at least 60% of a moved bone overlaps one visible SVG group in Setup, the bone automatically binds and applies the angle-preserving inset fit. A child bone has a large parent-linked joint and a smaller free endpoint: dragging the free endpoint rotates around the large joint, while the endpoint ring resizes along the bone axis.
8. **Setup** and **Pose** show the exact same guide placement. Setup is stored as the global rig baseline while every pose stores only its own delta. Arrange guides in Setup with the artwork frozen, then switch to Pose without a skeleton jump or accidental deformation.
   Bone pivots are kept in SVG-root space, and inherited transforms are factored out of nested bound groups, so source `translate`, `rotate`, or non-uniform `scale` transforms do not invert movement or apply a parent rotation twice.
9. Create or duplicate more poses. Every pose owns independent group transforms, bone transforms, and layer visibility. Use the eye beside an SVG group to swap alternate feet, hands, mouths, or other sprite parts for that pose only.
10. Set the pixel resolution, then choose **Fit ratio · centered** or **Stretch to output**.
11. Set **Edge antialias** from 0–100. At 0, alpha is strictly binary (0 or 255); higher values blend toward the renderer's smooth vector edge.
12. Toggle **Pixel** independently from Vector or Rig. Pixel docks beside the active workspace; clicking the active Vector/Rig tab leaves a pixel-only view, while Vector and Rig replace one another. Scroll over the Vector/Rig canvas to zoom from 25–400% around the cursor, and hold the middle mouse button while dragging to pan.
13. Optionally enable the **Pixel Art Rasterizer**. It supersamples the vector categorically, assigns every output pixel to one locked source-SVG color, forces binary alpha, removes double/L-corner pixels, and can discard tiny isolated clusters. This avoids blended seams and keeps the palette stable across poses.
14. Use **Play poses** to loop through named poses at 1, 2, 4, or 8 FPS. Rest is an editing reference and is not part of playback.
15. Export the active frame, or export every named pose as a single horizontal PNG tileset. Rest is never included automatically; create a named rest-like pose when you want one exported. The rasterizer uses the immutable source SVG as one shared palette for frame-to-frame color consistency.
16. Undo document edits with **Ctrl+Z** and redo with **Ctrl+Y** (or **Ctrl+Shift+Z**). A completed pointer drag—including automatic binding and fitting—is stored as one history command. With a bone selected, arrow keys nudge it by one exported pixel in root-canvas direction; hold Shift for ten pixels.
17. Save the full working document as a versioned `.astd` project with **Ctrl+S**. Use **Ctrl+Shift+S** for Save As and **Ctrl+O** to reopen a project. The file embeds the original SVG together with every pose, bone, visibility override, rig setup transform, and pixel-output setting.
18. Pose mode is remembered while checking Rest: Rest temporarily shows Setup, and returning to any named pose restores Pose mode automatically.

The most recent source, rest rig, pose, and pixel settings are also autosaved locally for crash recovery. Palettes, animation timelines, and soft mesh deformation are planned follow-up milestones.
