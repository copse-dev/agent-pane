/**
 * Entry for the Servo webview's `ws-bridge.js` bundle: the real preload,
 * verbatim, with `electron` aliased to the WebSocket bridge (`./electron.ts`)
 * by scripts/build-tauri.mts. Loaded by tauri.html as a classic script before
 * the app.js module, so `window.api` is installed first — the same ordering
 * Electron guarantees for its preload.
 */
import './servo-polyfills.ts'
import '../../preload/index.ts'
