// Build-time constants injected by esbuild's `define` (see scripts/build.mts,
// scripts/dev.mts, scripts/run-tests.mts). They are replaced with literals at
// bundle time, so branches guarded by a `false` value are dead-code-eliminated
// and the guarded source never ships.

/**
 * True in dev/test/e2e builds, false in release builds (`COPSE_RELEASE=1`).
 * Gates the `MockLLMProvider` test directives (`[[mcp:…]]`, `[[mock:…]]`) so the
 * directive parser is stripped from packaged apps rather than merely unreachable.
 */
declare const __COPSE_TEST_DIRECTIVES__: boolean

/** Exact Git commit embedded in desktop bundles; absent for unversioned test builds. */
declare const __COPSE_BUILD_COMMIT__: string

/** Whether working-tree changes were present when the desktop bundle was built. */
declare const __COPSE_BUILD_DIRTY__: boolean | null

/**
 * Sidecar-only (scripts/build-tauri.mts): the `ipcRenderer.invoke` / `.send`
 * channels extracted from the preload sources at bundle time. The WS server
 * enforces them as its inbound allowlist, so the Tauri transport exposes
 * exactly the channel surface the Electron preload does — undefined outside
 * the sidecar bundle, where the server fails closed to an empty allowlist.
 */
declare const __COPSE_WS_INVOKE_CHANNELS__: string[]
declare const __COPSE_WS_SEND_CHANNELS__: string[]
