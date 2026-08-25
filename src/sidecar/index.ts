/**
 * Tauri sidecar entry point: the entire Electron main process
 * (`src/main/index.ts`), byte-identical, running as a plain Node process.
 *
 * The magic is in the bundle, not here: `scripts/build-tauri.mts` builds this
 * entry with an esbuild alias mapping `electron` → `./electron-shim/index.ts`,
 * so every `import { app, BrowserWindow, ipcMain } from 'electron'` in
 * `src/main` resolves to the shim. Windows become requests to the Tauri shell
 * over stdio (shell-link), renderer IPC becomes a loopback WebSocket
 * (ws-server), and OS-integration APIs degrade per the plan in
 * docs/plans/tauri-servo-migration.md.
 *
 * Import order matters: the WS server must be reachable before any
 * `loadFile` runs (the shim awaits `wsEndpointReady()` there), and the shim's
 * shell-link listener starts at shim module init — both happen during this
 * module's import graph, before `../main/index.ts` evaluates.
 */
import { wsEndpointReady } from './ws-server.ts'
import '../main/index.ts'

// Start listening immediately (imports above have all evaluated by now, and
// main's boot chain is parked behind app.whenReady's macrotask) so the
// endpoint file exists early for headless smoke tests, rather than lazily on
// the first window load.
void wsEndpointReady()
