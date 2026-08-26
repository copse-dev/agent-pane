/**
 * Entry for the Servo webview's `ws-bridge.js` bundle: the real preload,
 * verbatim, with `electron` aliased to the WebSocket bridge (`./electron.ts`)
 * by scripts/build-tauri.mts. Loaded by tauri.html as a classic script before
 * the app.js module, so `window.api` is installed first — the same ordering
 * Electron guarantees for its preload.
 *
 * `startBridge()` runs *after* the preload import on purpose: URL scrub and
 * WebSocket open can throw under Servo on the custom scheme, and those must
 * not abort the script before `exposeInMainWorld('api', …)`.
 */
// perf-env must precede the preload: it populates the inert `process.env`
// that perf-bridge reads in a module-scope const.
import './perf-env.ts'
import './servo-polyfills.ts'
import { startBridge } from './electron.ts'
import '../../preload/index.ts'

startBridge()
