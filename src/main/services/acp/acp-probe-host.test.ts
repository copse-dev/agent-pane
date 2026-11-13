import { after, before, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { baseSandboxConfig } from '../../project-sandbox/config.ts'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import { isPidAlive } from '../exec/subprocess-kill.ts'
import { acpProbeWorkerPath, probeAcpAgentIsolated } from './acp-probe-host.ts'
import { ACP_PROBE_REQUEST_ENV } from './acp-probe-worker.ts'

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return condition()
}

describe('isolated ACP probe host', () => {
  let dir = ''

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'acp-probe-host-'))
    // Stand in for the bundled worker at its packaged path: a worker that hangs
    // and ignores SIGTERM, recording its pid in the probe's cwd.
    writeFileSync(
      acpProbeWorkerPath(),
      `const request = JSON.parse(process.env[${JSON.stringify(ACP_PROBE_REQUEST_ENV)}])
require('node:fs').writeFileSync(require('node:path').join(request.config.cwd, 'pid'), String(process.pid))
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
`,
    )
  })

  after(() => {
    rmSync(acpProbeWorkerPath(), { force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it('kills a timed-out worker that ignores SIGTERM', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX signal semantics')
      return
    }
    // The in-process fallback then probes this agent, which exits at once.
    await assert.rejects(
      probeAcpAgentIsolated(
        { command: process.execPath, args: ['-e', 'process.exit(3)'], cwd: dir },
        10,
      ),
    )
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    assert.ok(pid > 0)

    const dead = await waitFor(() => !isPidAlive(pid), 5_000)
    if (!dead) process.kill(pid, 'SIGKILL')
    assert.equal(dead, true, 'the SIGKILL fallback reaches a worker that outlived SIGTERM')
  })

  it('does not fall back to a main-process public-domain scope when a sandboxed probe returns no result', async () => {
    writeFileSync(
      acpProbeWorkerPath(),
      `require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'sandboxed-request'))}, process.env[${JSON.stringify(ACP_PROBE_REQUEST_ENV)}])\nprocess.exit(0)\n`,
    )
    let mainScopeUpdates = 0
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    mock.method(SandboxManager, 'getConfig', () => baseSandboxConfig())
    mock.method(SandboxManager, 'updateConfig', () => {
      mainScopeUpdates += 1
    })
    setProjectSandboxEnabled(true)
    try {
      await assert.rejects(
        probeAcpAgentIsolated({
          command: process.execPath,
          args: ['-e', "process.stdout.write('unexpected fallback')"],
          cwd: dir,
          sandbox: { allowedDomains: ['api.example'] },
        }),
        /stopped with code 0 and no result/,
      )
      assert.equal(mainScopeUpdates, 0)
      assert.match(readFileSync(join(dir, 'sandboxed-request'), 'utf8'), /"sandboxRequired":true/)
    } finally {
      setProjectSandboxEnabled(false)
      mock.restoreAll()
    }
  })

  it('bounds stderr from a failing worker and logs only a fixed diagnostic', async () => {
    writeFileSync(
      acpProbeWorkerPath(),
      "process.stderr.write('x'.repeat(512 * 1024), () => process.exit(2))\n",
    )
    const warnings: string[] = []
    mock.method(console, 'warn', (...parts: unknown[]) => {
      warnings.push(parts.map(String).join(' '))
    })
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    setProjectSandboxEnabled(true)
    try {
      await assert.rejects(
        probeAcpAgentIsolated({
          command: process.execPath,
          cwd: dir,
          sandbox: { allowedDomains: ['api.example'] },
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.match(error.message, /stopped with code 2 and no result/)
          assert.ok(error.message.length <= 66 * 1024)
          return true
        },
      )
      assert.deepEqual(warnings, ['[acp-probe-worker] worker wrote to stderr'])
    } finally {
      setProjectSandboxEnabled(false)
      mock.restoreAll()
    }
  })
})
