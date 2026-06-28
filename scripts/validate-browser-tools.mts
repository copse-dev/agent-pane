/**
 * End-to-end local validation for the built-in browser tools.
 *
 * Bundles a tiny Electron entry that drives the *real* BrowserSessionManager
 * against a local loopback HTTP server, then asserts the accessibility snapshot,
 * click, and type paths and saves a real screenshot PNG for the PR.
 *
 * Run: npm run validate:browser-tools
 */
import * as esbuild from 'esbuild'
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import electronBinary from 'electron'

// Bundle inside the project tree so the spawned Electron resolves `electron`.
const outDir = resolve('node_modules/.cache/copse-browser-validate')
mkdirSync(outDir, { recursive: true })
const entryFile = join(outDir, 'entry.cjs')
const resultFile = join(outDir, 'result.json')
const screenshotOut = resolve('tests/e2e/screenshots/browser-tools-live.png')

const entrySource = `
import { app } from 'electron'
import { createServer } from 'node:http'
import { writeFileSync, copyFileSync } from 'node:fs'
import { getBrowserSession, shutdownBrowserSession } from ${JSON.stringify(
  resolve('src/main/services/browser/session-manager.ts'),
)}

const PAGE = \`<!doctype html><html><head><title>Copse Browser Test</title></head>
<body>
  <h1>Computer Use Demo</h1>
  <a href="/docs">Documentation</a>
  <label>Search <input type="text" id="q" placeholder="Search docs" /></label>
  <button id="go">Run search</button>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      document.getElementById('go').textContent = 'searched:' + document.getElementById('q').value
    })
  </script>
</body></html>\`

async function main() {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(PAGE)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  const url = 'http://127.0.0.1:' + port + '/'

  const session = getBrowserSession()
  const result = {}
  try {
    result.navigate = await session.navigate(url)
    result.snapshot = await session.snapshot()

    // Find the textbox + button refs from the snapshot and drive them.
    const typeRef = (result.snapshot.match(/textbox[^\\n]*\\[ref=(e\\d+)\\]/) || [])[1]
    const buttonRef = (result.snapshot.match(/button[^\\n]*\\[ref=(e\\d+)\\]/) || [])[1]
    if (typeRef) result.type = await session.type(typeRef, 'hello world')
    if (buttonRef) result.click = await session.click(buttonRef)
    result.afterSnapshot = await session.snapshot()

    const shot = await session.screenshot()
    copyFileSync(shot.path, ${JSON.stringify(screenshotOut)})
    result.screenshot = ${JSON.stringify(screenshotOut)}
    result.ok = true
  } catch (err) {
    result.ok = false
    result.error = err && err.stack ? err.stack : String(err)
  } finally {
    writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result, null, 2))
    shutdownBrowserSession()
    server.close()
    app.quit()
  }
}

app.whenReady().then(main)
`

await esbuild.build({
  stdin: { contents: entrySource, resolveDir: process.cwd(), loader: 'ts' },
  outfile: entryFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  alias: { '@shared': resolve('./src/shared') },
})

const childEnv = { ...process.env }
delete childEnv['ELECTRON_RUN_AS_NODE'] // ensure full Electron runtime (app, BrowserWindow)
const proc = spawnSync(electronBinary as unknown as string, [entryFile], {
  stdio: 'inherit',
  env: childEnv,
})

if (!existsSync(resultFile)) {
  console.error('[validate-browser-tools] no result produced; electron exit:', proc.status)
  process.exit(1)
}

interface BrowserValidationResult {
  ok?: boolean
  navigate?: string
  snapshot?: string
  type?: string
  click?: string
  afterSnapshot?: string
  screenshot?: string
  error?: string
}

const result = JSON.parse(readFileSync(resultFile, 'utf8')) as BrowserValidationResult
console.log('\n=== browser_navigate ===')
console.log(result.navigate)
console.log('\n=== browser_snapshot ===')
console.log(result.snapshot)
console.log('\n=== browser_type ===', result.type)
console.log('=== browser_click ===', result.click)
console.log('\n=== snapshot after interaction ===')
console.log(result.afterSnapshot)
console.log('\n=== browser_screenshot ===', result.screenshot)

rmSync(outDir, { recursive: true, force: true })

const passed =
  result.ok === true &&
  typeof result.snapshot === 'string' &&
  result.snapshot.includes('Computer Use Demo') &&
  result.snapshot.includes('[ref=') &&
  typeof result.afterSnapshot === 'string' &&
  result.afterSnapshot.includes('"hello world"') &&
  result.afterSnapshot.includes('searched:hello world') &&
  existsSync(screenshotOut)

if (!passed) {
  console.error('\n[validate-browser-tools] FAILED', result.error ?? '')
  process.exit(1)
}
console.log('\n[validate-browser-tools] PASS — screenshot saved to', screenshotOut)
