// Contract tests for the run-deadline pause registry (H4, decision 13):
// "Blocking-hook wait pauses the idle deadline the same way tool execution
// does." Covers the registry primitives (register / clear-by-identity /
// pass-through) and an end-to-end proof that a blocking `toolGate` hook fire
// site pauses the registered deadline for the whole hook wait.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  registerRunDeadline,
  clearRunDeadline,
  withRunDeadlinePaused,
  resetRunDeadlinesForTest,
  type PausableRunDeadline,
} from './run-deadline.ts'
import { runToolGateHooks } from './tool-gate.ts'
import {
  userHooksConfigPath,
  resetCursorHookSessionErrorsForTest,
  setCursorHookTimeoutForTest,
} from './cursor-adapter.ts'

/** A deadline stub that records pause/resume calls and the max simultaneous depth. */
function countingDeadline(): PausableRunDeadline & {
  pauses: number
  resumes: number
  depth: number
  maxDepth: number
} {
  return {
    pauses: 0,
    resumes: 0,
    depth: 0,
    maxDepth: 0,
    pause(): void {
      this.pauses += 1
      this.depth += 1
      this.maxDepth = Math.max(this.maxDepth, this.depth)
    },
    resume(): void {
      this.resumes += 1
      this.depth -= 1
    },
  }
}

describe('run-deadline pause registry (H4)', () => {
  beforeEach(() => {
    resetRunDeadlinesForTest()
  })
  afterEach(() => {
    resetRunDeadlinesForTest()
  })

  it('pauses and resumes the registered deadline around the wrapped work', async () => {
    const deadline = countingDeadline()
    registerRunDeadline('thread-1', deadline)
    let pausedDuringFn = false
    const result = await withRunDeadlinePaused('thread-1', async () => {
      pausedDuringFn = deadline.depth === 1
      return 'ok'
    })
    assert.equal(result, 'ok')
    assert.equal(pausedDuringFn, true)
    assert.equal(deadline.pauses, 1)
    assert.equal(deadline.resumes, 1)
    assert.equal(deadline.depth, 0)
  })

  it('resumes even when the wrapped work throws', async () => {
    const deadline = countingDeadline()
    registerRunDeadline('thread-2', deadline)
    await assert.rejects(
      withRunDeadlinePaused('thread-2', () => Promise.reject(new Error('boom'))),
      /boom/,
    )
    assert.equal(deadline.pauses, 1)
    assert.equal(deadline.resumes, 1)
  })

  it('is a transparent pass-through with no session id or no registered deadline', async () => {
    // No session id at all.
    assert.equal(await withRunDeadlinePaused(undefined, () => Promise.resolve(1)), 1)
    // A session id with nothing registered (e.g. compose path before run start).
    assert.equal(await withRunDeadlinePaused('unknown', () => Promise.resolve(2)), 2)
  })

  it('clearRunDeadline only unregisters when the object still matches (stale-clear guard)', async () => {
    const first = countingDeadline()
    const second = countingDeadline()
    registerRunDeadline('thread-3', first)
    // A newer run reclaimed the thread with its own deadline.
    registerRunDeadline('thread-3', second)
    // The finished run tries to clear *its* (stale) deadline — must be a no-op.
    clearRunDeadline('thread-3', first)
    await withRunDeadlinePaused('thread-3', () => Promise.resolve())
    assert.equal(second.pauses, 1, 'the newer deadline is still registered and paused')
    // Clearing with the matching object removes it.
    clearRunDeadline('thread-3', second)
    await withRunDeadlinePaused('thread-3', () => Promise.resolve())
    assert.equal(second.pauses, 1, 'after a matching clear, nothing is paused')
  })
})

describe('blocking hook wait pauses the run deadline (H4 integration)', () => {
  let tempHome = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-run-deadline-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    resetRunDeadlinesForTest()
    resetCursorHookSessionErrorsForTest()
    setCursorHookTimeoutForTest(2_000)
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    resetRunDeadlinesForTest()
    setCursorHookTimeoutForTest()
    await rm(tempHome, { recursive: true, force: true })
  })

  it('a toolGate hook pauses the registered deadline for the whole wait', async () => {
    const threadId = 'gate-thread'
    const deadline = countingDeadline()
    registerRunDeadline(threadId, deadline)

    // A hook that sleeps briefly then denies — the pause must span its runtime.
    const script = join(tempHome, 'slow-gate.sh')
    await writeFile(
      script,
      `#!/bin/sh\ncat > /dev/null\nsleep 0.2\nprintf '%s' '{"permission":"deny"}'\n`,
      'utf-8',
    )
    await chmod(script, 0o755)
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(
      userHooksConfigPath(),
      JSON.stringify({ hooks: { beforeShellExecution: [{ command: script }] } }),
      'utf-8',
    )

    const decision = await runToolGateHooks(
      { toolName: 'run_shell', args: { command: 'rm -rf /' } },
      {
        workspaceRoot: null,
        projectTrusted: false,
        agentSession: { conversationId: threadId, generationId: 'g1' },
      },
    )

    // The gate actually ran the hook (blocking), and the deadline was paused for
    // exactly one balanced pause/resume pair spanning the wait.
    assert.equal(decision.permission, 'deny')
    assert.equal(deadline.pauses, 1)
    assert.equal(deadline.resumes, 1)
    assert.equal(deadline.maxDepth, 1)
    assert.equal(deadline.depth, 0)
  })

  it('does not pause when the tool gate matches no hooks (no wasted pause)', async () => {
    const threadId = 'gate-thread-empty'
    const deadline = countingDeadline()
    registerRunDeadline(threadId, deadline)
    const decision = await runToolGateHooks(
      { toolName: 'run_shell', args: { command: 'ls' } },
      {
        workspaceRoot: null,
        projectTrusted: false,
        agentSession: { conversationId: threadId, generationId: 'g1' },
      },
    )
    assert.equal(decision.permission, 'allow')
    // No hooks matched, so `runToolGateHooks` returns before the paused emit.
    assert.equal(deadline.pauses, 0)
  })
})
