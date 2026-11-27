import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import { hooksDialectsEnvironment } from '@copse/hooks-dialects/environment.ts'
import './hooks-dialects-environment.ts'

// With the macOS log monitor on, a hook's violation count must be this run's
// own, as run_shell's is. Hooks run the same command text every time, so a
// count keyed by that text includes every earlier run's denials in ASRT's
// rolling store, and a later deny (exit 2) is rewritten as a sandbox block.
describe('hook sandbox violation attribution', () => {
  const cleanups: Array<() => unknown> = []
  afterEach(async () => {
    mock.restoreAll()
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  it("counts only this run's own violations, never another run's", async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'copse-hook-attr-'))
    cleanups.push(() => rm(cwd, { recursive: true, force: true }))
    const command = './guard.sh'
    const attempts: string[] = []
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    mock.method(SandboxManager, 'cleanupAfterCommand', () => undefined)
    mock.method(
      SandboxManager,
      'wrapWithSandboxArgv',
      (
        _wrapped: string,
        ...rest: [unknown, unknown, unknown, unknown, { commandId?: string } | undefined]
      ) => {
        const id = rest[4]?.commandId
        if (id) attempts.push(id)
        return Promise.resolve({ argv: ['/bin/sh', '-c', 'exit 2'], env: { ...process.env } })
      },
    )
    // The store holds a denial keyed by the command text (a run before
    // per-attempt ids) and one under the first spawn's own id.
    const denial = [
      { line: 'sh(1) deny(1) file-write-create /Users/x/.claude/log', timestamp: new Date() },
    ]
    mock.method(
      SandboxManager.getSandboxViolationStore(),
      'getViolationsForCommand',
      (c: string) => (c === command || c === attempts[0] ? denial : []),
    )
    setProjectSandboxEnabled(true)
    cleanups.push(() => {
      setProjectSandboxEnabled(false)
    })

    const sandbox = hooksDialectsEnvironment().sandbox
    const run = async (): Promise<number> => {
      const child = await sandbox.spawnShell(command, { cwd, env: { ...process.env } })
      await new Promise((resolve) => child.once('close', resolve))
      return sandbox.violationCount(command, child)
    }
    // The first run's own denial counts: a blocked hook reads as blocked.
    assert.equal(await run(), 1)
    // A second run of the same command counts neither the first run's denial
    // nor the one keyed by the command text.
    assert.equal(await run(), 0)
    assert.equal(attempts.length, 2)
    assert.notEqual(attempts[0], attempts[1], 'each hook spawn carries its own attempt id')
  })
})
