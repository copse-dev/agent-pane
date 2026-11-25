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

  it('does not count an earlier run of the same hook command', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'copse-hook-attr-'))
    cleanups.push(() => rm(cwd, { recursive: true, force: true }))
    const command = './guard.sh'
    const attempts = new Set<string>()
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
        if (id) attempts.add(id)
        return Promise.resolve({ argv: ['/bin/sh', '-c', 'exit 2'], env: { ...process.env } })
      },
    )
    // An EARLIER run of the hook tripped a file denial; the store keys it by
    // the command text because that run had no per-attempt id.
    mock.method(
      SandboxManager.getSandboxViolationStore(),
      'getViolationsForCommand',
      (c: string) =>
        c === command
          ? [
              {
                line: 'sh(1) deny(1) file-write-create /Users/x/.claude/log',
                timestamp: new Date(),
              },
            ]
          : [],
    )
    setProjectSandboxEnabled(true)
    cleanups.push(() => {
      setProjectSandboxEnabled(false)
    })

    const sandbox = hooksDialectsEnvironment().sandbox
    const child = await sandbox.spawnShell(command, { cwd, env: { ...process.env } })
    await new Promise((resolve) => child.once('close', resolve))
    assert.equal(sandbox.violationCount(command, child), 0)
    assert.equal(attempts.size, 1, 'the hook spawn carries its own attempt id')
  })
})
