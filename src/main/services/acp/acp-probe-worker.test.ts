import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as esbuild from 'esbuild'
import { parseProbeWorkerOutput } from './acp-probe-host.ts'
import { ACP_PROBE_REQUEST_ENV, parseProbeRequest } from './acp-probe-worker.ts'

/**
 * Phase 4 of docs/plans/sandbox-network-scope-isolation.md: the ACP model probe
 * runs in a helper process owning its own `SandboxManager`, so a background probe
 * cannot widen the app's process-global network allowlist.
 */

// The test runner compiles to `dist-test/` and runs node from the repo root, so
// `import.meta.dirname` is undefined under CJS — use the runner's cwd instead.
const REPO_ROOT = process.cwd()

/**
 * Bundle into the repo, not the system temp dir: the worker externalizes ASRT
 * (and the rest of `nodeOpts.external`), so Node must be able to resolve those
 * from the bundle's location — which is what happens in the packaged app, where
 * `dist/main/` sits beside the app's node_modules.
 */
function makeBundleDir(prefix: string): string {
  const base = join(REPO_ROOT, 'dist-test', 'acp-probe-fixtures')
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, prefix))
}

function bundleWorker(outDir: string): string {
  const outfile = join(outDir, 'acp-probe-worker.js')
  esbuild.buildSync({
    entryPoints: [join(REPO_ROOT, 'src/main/services/acp/acp-probe-worker.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    alias: { '@shared': join(REPO_ROOT, 'src/shared') },
    // Mirror scripts/build.mts `nodeOpts.external`. ASRT in particular must stay
    // external: it evaluates `import.meta.url` at module scope, which is undefined
    // in a CJS bundle and throws at load.
    external: [
      'electron',
      '@anthropic-ai/sandbox-runtime',
      'shell-quote',
      'node-pty',
      'jsdom',
      '@mozilla/readability',
      'turndown',
      'electron-updater',
    ],
  })
  return outfile
}

/**
 * A minimal ACP agent over stdio: answers `initialize` and `session/new` with a
 * model selector, then idles. Enough to exercise the real handshake the worker
 * performs, without depending on a vendor CLI being installed.
 */
const FAKE_AGENT = `
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk.toString()
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.method === 'initialize') {
      respond(msg.id, { protocolVersion: msg.params?.protocolVersion ?? 1, agentCapabilities: {} })
    } else if (msg.method === 'session/new') {
      respond(msg.id, {
        sessionId: 'sess-1',
        configOptions: [{
          id: 'model', name: 'Model', category: 'model', type: 'select',
          currentValue: 'fast',
          options: [{ value: 'fast', name: 'Fast' }, { value: 'deep', name: 'Deep' }],
        }],
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      })
    } else if (msg.id !== undefined) {
      respond(msg.id, {})
    }
  }
})
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}
`

function runWorker(
  workerPath: string,
  request: unknown,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath], {
      cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        [ACP_PROBE_REQUEST_ENV]: JSON.stringify(request),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    child.once('close', (code) => {
      resolve({ stdout, stderr, code })
    })
  })
}

describe('acp probe worker', () => {
  // The worker runs as a plain Node script, so a native module anywhere in its
  // import graph fails at REQUIRE time — which `assertParses` in the build cannot
  // catch. acp-client.ts is kept bundleable for this reason; the guard belongs
  // here so an innocent-looking import in that graph fails a test, not a release.
  it('bundles free of electron and node-pty', () => {
    const dir = makeBundleDir('bundle-')
    const outfile = bundleWorker(dir)
    const code = readFileSync(outfile, 'utf-8')
    assert.equal(/require\(["']node-pty["']\)/.test(code), false, 'worker bundle requires node-pty')
    assert.equal(/require\(["']electron["']\)/.test(code), false, 'worker bundle requires electron')
  })

  it('probes a real agent process and returns its selectors as JSON', async () => {
    const dir = makeBundleDir('run-')
    const workerPath = bundleWorker(dir)
    const agentPath = join(dir, 'fake-agent.mjs')
    writeFileSync(agentPath, FAKE_AGENT)

    const { stdout } = await runWorker(
      workerPath,
      { config: { command: process.execPath, args: [agentPath], cwd: dir }, timeoutMs: 10_000 },
      dir,
    )

    const probe = parseProbeWorkerOutput(stdout)
    assert.ok(probe, 'worker returned no probe result')
    assert.deepEqual(probe.models, {
      configId: 'model',
      currentValue: 'fast',
      choices: [
        { value: 'fast', label: 'Fast' },
        { value: 'deep', label: 'Deep' },
      ],
    })
    assert.deepEqual(probe.modes?.choices, [{ value: 'default', label: 'Default' }])
  })

  it('reports a failing agent as a structured error rather than hanging', async () => {
    const dir = makeBundleDir('fail-')
    const workerPath = bundleWorker(dir)

    const { stdout } = await runWorker(
      workerPath,
      {
        config: { command: process.execPath, args: ['-e', 'process.exit(3)'], cwd: dir },
        timeoutMs: 10_000,
      },
      dir,
    )

    assert.throws(() => parseProbeWorkerOutput(stdout), /ACP agent|exited/i)
  })

  it('rejects a malformed request instead of probing', async () => {
    const dir = makeBundleDir('bad-')
    const workerPath = bundleWorker(dir)
    const { stdout } = await runWorker(workerPath, { config: { cwd: dir } }, dir)
    assert.throws(() => parseProbeWorkerOutput(stdout), /invalid probe request/)
  })
})

describe('parseProbeRequest', () => {
  it('requires a command and cwd', () => {
    assert.equal(parseProbeRequest('{"config":{"command":"x"}}'), null)
    assert.equal(parseProbeRequest('{"config":{"cwd":"/tmp"}}'), null)
    assert.equal(parseProbeRequest('not json'), null)
    assert.deepEqual(
      parseProbeRequest('{"config":{"command":"x","cwd":"/tmp"}}')?.config.command,
      'x',
    )
  })

  it('keeps a positive timeout and drops a nonsensical one', () => {
    const base = '{"config":{"command":"x","cwd":"/tmp"}'
    assert.equal(parseProbeRequest(`${base},"timeoutMs":500}`)?.timeoutMs, 500)
    assert.equal(parseProbeRequest(`${base},"timeoutMs":-1}`)?.timeoutMs, undefined)
  })
})

describe('parseProbeWorkerOutput', () => {
  it('ignores non-result lines and reads the result line', () => {
    const stdout = 'warming up\n{"ok":true,"probe":{"models":null,"modes":null}}\n'
    assert.deepEqual(parseProbeWorkerOutput(stdout), { models: null, modes: null })
  })

  it('turns a worker-reported failure into a throw', () => {
    assert.throws(() => parseProbeWorkerOutput('{"ok":false,"error":"boom"}'), /boom/)
  })

  it('returns null when the worker produced no verdict', () => {
    assert.equal(parseProbeWorkerOutput('nothing useful here\n'), null)
  })
})
