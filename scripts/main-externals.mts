/**
 * The modules the main-process bundles leave external, enumerated in one place
 * (same reason as `main-bundles.mts`).
 *
 * Two bundlers consume this: `build.mts` for the Electron main process, and
 * `build-tauri.mts` for the servo-mode sidecar, which is that same code with
 * `electron` aliased to a shim. The sidecar kept its own hand-copied list, and
 * it rotted the moment main gained a dependency the copy did not: `@napi-rs/
 * keyring` is a prebuilt `.node` binding, so bundling it fails outright with
 * "No loader is configured for .node files" — and only on the servo build, which
 * no CI job runs.
 *
 * The property that has to hold is per-module rather than per-bundler: a native
 * binding or a lazy `require` is unbundlable in both bundles or neither. So the
 * list is shared, and each consumer subtracts what its own aliasing covers.
 */
export const MAIN_EXTERNALS = [
  'electron',
  '@anthropic-ai/sandbox-runtime',
  'shell-quote',
  'node-pty',
  // Native keyring binding (prebuilt .node per platform); resolved from the
  // packaged node_modules at runtime like node-pty.
  '@napi-rs/keyring',
  'jsdom',
  '@mozilla/readability',
  'turndown',
  // electron-updater lazy-requires its provider backends (GitHub/S3/generic)
  // and js-yaml at runtime; bundling breaks those dynamic requires. It ships as
  // a production dependency, so electron-builder packs it into the app's
  // node_modules where the asar-aware require resolves it at runtime.
  'electron-updater',
] as const
