# Asset Studio project agent

## Mission

Build a production-quality desktop asset editor for posing grouped SVG artwork and exporting crisp pixel-art PNGs. The source SVG is immutable: every edit must be represented as project metadata, never written back into the imported bytes.

## Architecture

- Desktop shell: Tauri 2.
- Editor chrome: Svelte 5 and TypeScript.
- Interactive/pixel viewport: CanvasKit (Skia/WASM), kept local to the WebView render loop.
- Shared editor math and serializable model: Rust compiled to WebAssembly; avoid Tauri IPC during pointer gestures.
- Native file and deterministic PNG export operations: Rust in `src-tauri`.
- Reusable toolchain and caches live under `D:\Env\asset-studio`; do not install project tools globally.

## Product invariants

- Preserve the byte-exact imported SVG in application state/project storage.
- Treat the source/rest pose as read-only.
- Store each named pose independently as per-group transform overrides relative to the source.
- Never make one pose inherit mutable values from another pose.
- One completed drag is one undoable operation; do not create commands for every pointer event.
- Keep per-frame interaction in the WebView/WASM process.
- Sanitize untrusted SVG before previewing it. Do not execute scripts, event attributes, `foreignObject`, or remote resources.
- Pixel preview and exported PNG must use the requested output resolution and nearest-neighbor display scaling.

## Working agreements

- Activate `D:\Env\asset-studio\activate.ps1` before running Node, Cargo, or Tauri commands.
- Use `pnpm`; keep the lockfile committed.
- After TypeScript/Svelte changes run `pnpm check` and `pnpm build`.
- After Rust changes run `cargo test --manifest-path crates/studio-core/Cargo.toml` and `cargo check --manifest-path src-tauri/Cargo.toml`.
- Keep CanvasKit objects short-lived or explicitly call `.delete()` when the API requires it.
- Prefer small typed modules under `src/lib/editor` over growing the route component indefinitely.

## Current scope

The first milestone supports SVG import, group selection, translate/rotate/scale, independent named poses, pixel preview, and PNG export. Rigid bones, timelines, mesh deformation, palettes, dithering, and `.assetstudio` project archives are subsequent milestones unless a task explicitly brings them into scope.
