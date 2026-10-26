# blockviz (vendored)

Vendored from [BlueBlazin/blockviz](https://github.com/BlueBlazin/blockviz)
at commit [`54e67b1`](https://github.com/BlueBlazin/blockviz/commit/54e67b1b76e31c992344a30ef0555c40bf5b441f)
(2026-10-17), MIT licence, copyright Sanjeet Dasharath. The original licence
text is in `LICENSE`.

Turns a codebase into zoomable, nested architecture-style block diagrams
(repo → file → function → call), analyzed by a Rust core compiled to
WebAssembly. See `FEATURES.md` for what it does and the upstream README for
how the diagrams are built.

Why a copy rather than a dependency: the web app is `"private": true` (not
published), and we need to modify its Rust layout core (see Known issues,
below) and add a way to feed it a local project's files directly — upstream
only ever reads from GitHub, a browser folder picker, or drag-and-drop.

Dropped from upstream: `crates/blockviz-app` (a native desktop build on Zed's
GPUI framework, irrelevant to an Electron embed) and its separate
`Cargo.lock`/`Cargo.toml`.

Changes from upstream:

- `embeddedProject` (`src/core/loaders.ts`) and the `'embedded'` `OpenRequest`
  kind (`src/ui/OpenDialog.tsx`, wired in `src/App.tsx`): Copse hands the app
  files read from the current project directly, via
  `window.__copseLoadFiles(files, name)`, bypassing GitHub and the browser's
  folder-picker/drag-and-drop input paths. Gated behind `#embedded=1` in the
  URL so the app waits for that call instead of loading the bundled nanoGPT
  example or a GitHub link on first paint.

## Known issues (tracked, not yet fixed)

- Upstream's layout/sizing step can make a settings-shaped JSON or doc file
  outrank a folder holding the real source (observed on this repo: top-level
  fixture JSON files rendered larger than `packages/`, which held nearly
  everything). Not yet root-caused; see `crates/blockviz-core/src/layout/`.

## Building

This crate/app is built outside this repo's required CI (see
`.github/workflows/build-blockviz.yml`, `workflow_dispatch` only) and fetched
as a prebuilt, checksum-verified artifact at dev/runtime by
`scripts/fetch-blockviz.mts` — the same pattern as `scripts/fetch-gortex.mts`.
To build it locally: `cd vendor/blockviz && npm install && npm run build`
(needs a Rust toolchain with the `wasm32-unknown-unknown` target, and
`wasm-pack`).
