import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import childProcess, { type ChildProcess, type SpawnOptions } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { probeAcpAgentIsolated } from '../services/acp/acp-probe-host.ts'
import { spawnSandboxedAcpSessionHost } from '../services/acp/acp-session-host.ts'
import { setProjectSandboxEnabled } from './enabled.ts'
import { spawnBackgroundProcess } from './spawn.ts'

/**
 * The workers that run ASRT themselves start in the workspace, and ASRT looks
 * its helpers up through the PATH they inherit. Each spawn must hand them only
 * absolute entries.
 */

const INHERITED_PATH = 'bin::/opt/tools/bin:.:/usr/bin:./x:/bin:'
const WORKER_PATH = '/opt/tools/bin:/usr/bin:/bin'

/**
 * Record the env of the worker spawned from this process's own binary, and run
 * `script` in its place, so the code under test still gets a real child.
 */
function captureWorkerEnv(t: TestContext, script: string): () => NodeJS.ProcessEnv | undefined {
  const realSpawn = childProcess.spawn
  let captured: NodeJS.ProcessEnv | undefined
  t.mock.method(
    childProcess,
    'spawn',
    (file: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
      if (file !== process.execPath) return realSpawn(file, args, options)
      captured = options.env
      return realSpawn(file, ['-e', script], options)
    },
  )
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  return () => captured
}

/** Run `body` in a fresh directory with the sandbox reported active and `PATH` unfiltered. */
async function withInheritedPath(
  t: TestContext,
  body: (cwd: string) => Promise<void>,
): Promise<void> {
  t.mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
  const cwd = await mkdtemp(join(tmpdir(), 'copse-worker-env-'))
  const previous = process.env['PATH']
  process.env['PATH'] = INHERITED_PATH
  setProjectSandboxEnabled(true)
  try {
    await body(cwd)
  } finally {
    setProjectSandboxEnabled(false)
    process.env['PATH'] = previous
    await rm(cwd, { recursive: true, force: true })
  }
}

describe('worker processes that run ASRT', { skip: process.platform === 'win32' }, () => {
  it('start the port-binding worker with only absolute PATH entries', async (t) => {
    const workerEnv = captureWorkerEnv(t, 'process.exit(0)')
    await withInheritedPath(t, async (cwd) => {
      const child = await spawnBackgroundProcess('true', { cwd, allowPortBinding: true })
      await once(child, 'close')
    })
    assert.equal(workerEnv()?.['PATH'], WORKER_PATH)
  })

  it('start the ACP session host with only absolute PATH entries', async (t) => {
    const workerEnv = captureWorkerEnv(t, "process.send({ type: 'ready' }, () => process.exit(0))")
    await withInheritedPath(t, async (cwd) => {
      const child = await spawnSandboxedAcpSessionHost({
        command: 'agent',
        cwd,
        sandbox: { allowedDomains: [] },
      })
      if (child.exitCode === null) await once(child, 'close')
    })
    assert.equal(workerEnv()?.['PATH'], WORKER_PATH)
  })

  it('start the ACP probe worker with only absolute PATH entries', async (t) => {
    const workerEnv = captureWorkerEnv(
      t,
      "process.stdout.write(JSON.stringify({ ok: true, probe: {} }) + '\\n')",
    )
    await withInheritedPath(t, async (cwd) => {
      await probeAcpAgentIsolated({ command: 'agent', cwd, sandbox: { allowedDomains: [] } })
    })
    assert.equal(workerEnv()?.['PATH'], WORKER_PATH)
  })
})
