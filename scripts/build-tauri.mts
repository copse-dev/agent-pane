/**
 * Build the Tauri/Servo prototype artifacts on top of a normal `pnpm build`:
 *
 *   1. `dist/sidecar/index.js`   — src/main/index.ts as a plain Node process,
 *                                  with `electron` aliased to the sidecar shim.
 *   2. `dist/sidecar/*.js`       — the standalone worker bundles the main
 *                                  process spawns by path (same list build.mts
 *                                  emits into dist/main).
 *   3. `dist/renderer/ws-bridge.js` — the real preload bundled for the Servo
 *                                  webview, `electron` aliased to the WS bridge.
 *   4. `dist/renderer/tauri.html` — index.html with the bridge script injected
 *                                  and the CSP widened for the loopback WS.
 *
 * Not an entry point: `scripts/build.mts` imports this at the end of a
 * `--servo` build, so the artifacts above are assembled from the ones it has
 * just emitted. Run `pnpm build:servo`, then `cd tauri-shell && cargo run`.
 * See docs/plans/tauri-servo-migration.md.
 */
import * as esbuild from 'esbuild'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { STANDALONE_MAIN_BUNDLES } from './main-bundles.mts'
import { MAIN_EXTERNALS } from './main-externals.mts'
import { prepareServoEngine } from './servo-engine.mts'

const sharedAlias = {
  '@shared': resolve('./src/shared'),
  '@copse/agent': resolve('./packages/agent/src'),
  '@copse/llm': resolve('./packages/llm/src'),
  '@copse/plan-usage': resolve('./packages/plan-usage/src'),
}

if (!existsSync('dist/renderer/index.html')) {
  console.error('dist/renderer is missing — build the app with `pnpm build:servo`.')
  process.exit(1)
}

// Which engine `cargo run` will resolve against. Done here rather than left to
// the reader because the answer changes what tauri.html may contain: an
// enforced CSP needs the patched engine, and the two used to default
// independently — the build wrote an enforced policy while cargo built stock
// servo, so the window came up blank with every subresource blocked.
const engine = prepareServoEngine()
console.log(`servo engine: ${engine.mode} (${engine.detail})`)

const define = {
  __COPSE_TEST_DIRECTIVES__: 'true',
  __COPSE_BUILD_COMMIT__: JSON.stringify(null),
  __COPSE_BUILD_DIRTY__: JSON.stringify(null),
}

// The sidecar's inbound channel allowlist, generated from the preload
// contract. Under Electron the renderer reaches only the channels the preload
// exposes; over the WS transport any page script could open its own socket,
// so the server must enforce the same surface or a renderer compromise would
// escalate to every registered ipcMain channel. Extracted from the literal
// channel names in the preload sources at build time — the same sources the
// ws-bridge bundle is built from, so the two cannot drift.
function extractPreloadChannels(): { invoke: string[]; send: string[] } {
  const preloadDir = 'src/preload'
  const invoke = new Set<string>()
  const send = new Set<string>()
  for (const name of readdirSync(preloadDir)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
    // The decoder window's preload is not part of the ws-bridge bundle — the
    // prototype does not bridge that window — so its channels stay off the
    // allowlist (fail closed). Bridging it later means adding its channels
    // here, or the transport will reject them with 4007.
    if (name === 'video-decoder.ts') continue
    const source = readFileSync(resolve(preloadDir, name), 'utf8')
    for (const match of source.matchAll(/ipcRenderer\s*\.\s*invoke\(\s*'([^']+)'/g)) {
      invoke.add(match[1] ?? '')
    }
    for (const match of source.matchAll(/ipcRenderer\s*\.\s*send\(\s*'([^']+)'/g)) {
      send.add(match[1] ?? '')
    }
    // A computed channel name would silently escape the allowlist; the
    // preload only ever uses literals, so treat anything else as a build
    // error rather than shipping a broken contract.
    // `(?![\s'])` rather than `(?!')`: `\s*` backtracks, so a lookahead for
    // just the quote would false-positive on multi-line literal calls.
    for (const match of source.matchAll(/ipcRenderer\s*\.\s*(invoke|send)\(\s*(?![\s'])/g)) {
      console.error(`non-literal ipcRenderer.${match[1] ?? ''}( channel in ${preloadDir}/${name}`)
      process.exit(1)
    }
  }
  invoke.delete('')
  send.delete('')
  if (invoke.size < 100) {
    console.error(
      `preload channel extraction found only ${String(
        invoke.size,
      )} invoke channels — the scanner is broken.`,
    )
    process.exit(1)
  }
  return { invoke: [...invoke].sort(), send: [...send].sort() }
}
const preloadChannels = extractPreloadChannels()
console.log(
  `preload contract: ${String(preloadChannels.invoke.length)} invoke + ${String(
    preloadChannels.send.length,
  )} send channels`,
)

const nodeOpts = {
  bundle: true,
  platform: 'node' as const,
  format: 'cjs' as const,
  // The main process's externals minus `electron`, which the sidecar aliases
  // to its shim instead of leaving external.
  external: MAIN_EXTERNALS.filter((name) => name !== 'electron'),
  sourcemap: true,
  target: 'node22',
  define,
}

// 1. The sidecar: the whole main process with the electron shim.
await esbuild.build({
  ...nodeOpts,
  define: {
    ...define,
    __COPSE_WS_INVOKE_CHANNELS__: JSON.stringify(preloadChannels.invoke),
    __COPSE_WS_SEND_CHANNELS__: JSON.stringify(preloadChannels.send),
  },
  external: nodeOpts.external.filter((name) => name !== 'electron-updater'),
  entryPoints: ['src/sidecar/index.ts'],
  outfile: 'dist/sidecar/index.js',
  alias: {
    ...sharedAlias,
    electron: resolve('./src/sidecar/electron-shim/index.ts'),
    // Inert stub: electron-updater must never load in the sidecar (its lazy
    // internals require('electron')); the Tauri updater plugin replaces it.
    'electron-updater': resolve('./src/sidecar/electron-shim/electron-updater.ts'),
  },
})

// 2. The standalone worker bundles, emitted next to the sidecar because the
// runtime resolves them relative to its own bundle (`__dirname`). These must
// stay electron-free, so they keep `electron` external (a stray import fails
// at require time, same contract as build.mts).
for (const { entry, outfile } of STANDALONE_MAIN_BUNDLES) {
  await esbuild.build({
    ...nodeOpts,
    external: [...nodeOpts.external, 'electron'],
    alias: sharedAlias,
    entryPoints: [entry],
    outfile: `dist/sidecar/${basename(outfile)}`,
  })
}

// 3. The renderer-side bridge: the real preload over WebSocket.
await esbuild.build({
  bundle: true,
  platform: 'browser' as const,
  format: 'iife' as const,
  sourcemap: true,
  entryPoints: ['src/sidecar/ws-bridge/entry.ts'],
  outfile: 'dist/renderer/ws-bridge.js',
  alias: {
    ...sharedAlias,
    electron: resolve('./src/sidecar/ws-bridge/electron.ts'),
  },
  define,
  // The preload gates test/perf bridges on process.env; give the browser
  // bundle an inert `process` so those guards evaluate to off.
  banner: { js: 'var process = { env: {} };' },
})

// 4. tauri.html: index.html + the bridge, with the CSP rewritten for the
// tauri:// origin. The policy is the Electron one plus a connect-src for the
// loopback WebSocket the renderer uses to reach the sidecar.
//
// Enforced by default, which is only correct because the engine is patched by
// default: servo 0008 gives a registered custom scheme a tuple origin and
// csp-0001 matches 'self' against it, both carried by the fork branches
// tauri-shell/Cargo.toml pins. Against a stock libservo, tauri://localhost has
// an opaque origin that 'self' can never match, so the policy blocks every
// same-origin subresource and the window comes up blank. If you are
// deliberately on stock — `cargo run --no-default-features` — set
// COPSE_TAURI_STRIP_CSP=1 here to match.
const TAURI_CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'; connect-src 'self' ws://127.0.0.1:*;"
const indexHtml = readFileSync('dist/renderer/index.html', 'utf8')
const cspMetaPattern = /[ \t]*<meta\s+http-equiv="Content-Security-Policy"[^>]*\/>\n?/
const withCsp = indexHtml.replace(
  cspMetaPattern,
  process.env['COPSE_TAURI_STRIP_CSP'] === '1'
    ? ''
    : `    <meta http-equiv="Content-Security-Policy" content="${TAURI_CSP}" />\n`,
)
if (withCsp === indexHtml) {
  console.error('CSP meta not found in index.html — tauri.html transform needs updating.')
  process.exit(1)
}
const withBridge = withCsp.replace(
  '<script type="module" src="./app.js">',
  '<script src="./ws-bridge.js"></script>\n    <script type="module" src="./app.js">',
)
if (withBridge === withCsp) {
  console.error('app.js script tag not found in index.html — tauri.html transform needs updating.')
  process.exit(1)
}
writeFileSync('dist/renderer/tauri.html', withBridge)

// 5. Invariant: the Tauri build uses the `electron` package for TYPES ONLY.
// No emitted bundle may load electron (or electron-updater, whose internals
// lazily require electron) at runtime — the aliases above must have
// substituted every value import. Type-only imports are erased and never
// reach the bundles, so any hit here is a real regression.
const emitted = [
  'dist/sidecar/index.js',
  ...STANDALONE_MAIN_BUNDLES.map(({ outfile }) => `dist/sidecar/${basename(outfile)}`),
  'dist/renderer/ws-bridge.js',
]
for (const file of emitted) {
  const source = readFileSync(file, 'utf8')
  const hit = source.match(/require\((["'])electron(-updater)?\1\)|from\s*(["'])electron\3/)
  if (hit) {
    console.error(`${file} still loads electron at runtime (${hit[0]}) — alias or stub it.`)
    process.exit(1)
  }
}

console.log('electron is types-only in the tauri bundles ✓')

console.log(
  'tauri prototype artifacts built: dist/sidecar/, dist/renderer/ws-bridge.js, dist/renderer/tauri.html',
)
