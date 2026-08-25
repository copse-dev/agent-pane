/**
 * Hand the Servo webview the two environment values the preload's perf tracer
 * reads (`src/preload/perf-bridge.ts`), so `COPSE_PERF=1` produces the same
 * renderer records under the Tauri shell as it does under Electron.
 *
 * Under Electron, main sets `COPSE_PERF_ORIGIN` in its own environment while
 * arming the tracer and the renderer process inherits it at fork time; the
 * preload just reads `process.env`. A Servo webview has no environment at all,
 * and `scripts/build-tauri.mts` deliberately gives the browser bundle an inert
 * `var process = { env: {} }` so those guards evaluate to off rather than
 * throwing. The result is that the perf bridge ships in `ws-bridge.js` (the
 * bundle is the real preload) but can never arm.
 *
 * So the sidecar publishes the same two values on the boot URL, beside
 * `winId`/`wsPort`/`wsToken` (see `BrowserWindow.loadFile` in
 * ../electron-shim/index.ts) — the only channel that reaches a webview before
 * it runs any of our code — and this module copies them into that inert env.
 *
 * It has to happen before `../../preload/index.ts` is evaluated, because
 * perf-bridge captures the flag in a module-scope `const`. That ordering is the
 * entire reason this is a separate module imported first by entry.ts rather
 * than a few lines inside the preload.
 */

// The banner esbuild prepends to this bundle, not Node's global. Declared
// locally because the web tsconfig has no Node types — and should not gain
// them for one stub.
declare const process: { env: Record<string, string | undefined> }

const params = new URLSearchParams(window.location.search)
if (params.get('copsePerf') === '1') {
  process.env['COPSE_PERF'] = '1'
  const origin = params.get('copsePerfOrigin')
  // Absent origin is survivable: perf-bridge falls back to `Date.now()`, which
  // costs a shared axis with main but still yields usable durations.
  if (origin !== null && origin !== '') process.env['COPSE_PERF_ORIGIN'] = origin
  if (params.get('copseAutopilot') === '1') process.env['COPSE_PERF_AUTOPILOT'] = '1'
}

export {}
