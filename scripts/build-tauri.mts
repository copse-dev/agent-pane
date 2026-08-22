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
 * Run `pnpm build` first (this script checks); then `pnpm build:tauri`; then
 * `cd tauri-shell && cargo run`. See docs/plans/tauri-servo-migration.md.
 */
import * as esbuild from 'esbuild'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { STANDALONE_MAIN_BUNDLES } from './main-bundles.mts'

const sharedAlias = {
  '@shared': resolve('./src/shared'),
  '@copse/agent': resolve('./packages/agent/src'),
  '@copse/llm': resolve('./packages/llm/src'),
  '@copse/plan-usage': resolve('./packages/plan-usage/src'),
}

if (!existsSync('dist/renderer/index.html')) {
  console.error('dist/renderer is missing — run `pnpm build` before `pnpm build:tauri`.')
  process.exit(1)
}

const define = {
  __COPSE_TEST_DIRECTIVES__: 'true',
  __COPSE_BUILD_COMMIT__: JSON.stringify(null),
  __COPSE_BUILD_DIRTY__: JSON.stringify(null),
}

const nodeOpts = {
  bundle: true,
  platform: 'node' as const,
  format: 'cjs' as const,
  external: [
    // Same externals as build.mts minus `electron`, which the sidecar aliases
    // to its shim instead of leaving external.
    '@anthropic-ai/sandbox-runtime',
    'shell-quote',
    'node-pty',
    'jsdom',
    '@mozilla/readability',
    'turndown',
    'electron-updater',
  ],
  sourcemap: true,
  target: 'node22',
  define,
}

// 1. The sidecar: the whole main process with the electron shim.
await esbuild.build({
  ...nodeOpts,
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
// loopback WebSocket the renderer uses to reach the sidecar. Enforcing it
// requires the recommended engine patches (servo 0008 + csp-0001 in the tauri
// fork's servo-patches/): stock pinned Servo gives tauri://localhost an opaque
// origin that CSP 'self' can never match, so there any policy blocks every
// same-origin subresource and the window stays blank — set
// COPSE_TAURI_STRIP_CSP=1 to reproduce the old stripped-meta build for
// unpatched-engine runs.
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
