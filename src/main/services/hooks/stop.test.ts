// Contract tests for the `stop` fire site (B3).
//
// Pins the B3 acceptance surface: `stop` fires the moment agent work stops with
// the correct `status` on stdin (`completed` on a normal turn end, `aborted` on
// an abort); it is dispatched **detached** — a slow `stop` hook never blocks the
// caller (decision 3, no drain barrier); and, being notification-only, a
// crashing/failClosed hook never throws or surfaces a decision. Same house style
// as `before-submit-prompt.test.ts` — a real spawned script driven through the
// canonical `stop` registry → runner → adapter seam.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expectRecord, parseJsonUnknown } from '@shared/unknown-value.ts'
import {
  userHooksConfigPath,
  resetCursorHookSessionErrorsForTest,
  setCursorHookTimeoutForTest,
} from './cursor-adapter.ts'
import { runStopHooks } from './stop.ts'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'

let threadCounter = 0

/**
 * Fire the canonical stop event (the production turn-end / abort path). Each
 * call uses a fresh thread id so the shared detached dispatcher's per-thread
 * `whenIdle` (`settled`) is isolated across tests.
 */
function fireStop(status: 'completed' | 'aborted'): ReturnType<typeof runStopHooks> {
  const threadId = `stop-test-thread-${String(threadCounter++)}`
  return runStopHooks(status, {
    threadId,
    turnTreeId: asTurnTreeId(`${threadId}:turn`),
    workspaceRoot: null,
    projectTrusted: false,
  })
}

describe('stop (turn-end / abort fire site — B3)', () => {
  let tempHome = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-stop-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    resetCursorHookSessionErrorsForTest()
    setCursorHookTimeoutForTest(2_000)
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    setCursorHookTimeoutForTest()
    await rm(tempHome, { recursive: true, force: true })
  })

  async function writeUserHooks(config: unknown): Promise<void> {
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(userHooksConfigPath(), JSON.stringify(config), 'utf-8')
  }

  /** Write an executable shell script that copies its stdin to `stdinFile`. */
  async function writeCaptureHook(name: string, stdinFile: string): Promise<string> {
    const path = join(tempHome, name)
    await writeFile(path, `#!/bin/sh\ncat > '${stdinFile}'\n`, 'utf-8')
    await chmod(path, 0o755)
    return path
  }

  it('does nothing when no stop hooks are registered', async () => {
    const result = await fireStop('completed')
    assert.equal(result.ran, 0)
    await result.settled
  })

  it('fires on a normal turn end with status "completed"', async () => {
    const stdinFile = join(tempHome, 'completed.json')
    const script = await writeCaptureHook('stop-completed.sh', stdinFile)
    await writeUserHooks({ hooks: { stop: [{ command: script }] } })

    const result = await fireStop('completed')
    assert.equal(result.ran, 1)
    // Detached: the hook runs off the critical path — await its completion (a
    // test affordance) before inspecting what it captured.
    await result.settled
    assert.equal(existsSync(stdinFile), true)
    const stdin = expectRecord(parseJsonUnknown(readFileSync(stdinFile, 'utf-8')))
    assert.equal(stdin['status'], 'completed')
  })

  it('sends `loop_count` so a vendor hook gating on it can actually fire', async () => {
    // Cursor's documented stop-hook example gates its follow-up on
    // `loop_count < N`; an absent field makes that comparison silently false.
    // Copse never auto-submits a follow-up, so the honest value is always 0.
    const stdinFile = join(tempHome, 'loop-count.json')
    const script = await writeCaptureHook('stop-loop-count.sh', stdinFile)
    await writeUserHooks({ hooks: { stop: [{ command: script }] } })

    const result = await fireStop('completed')
    await result.settled
    const stdin = expectRecord(parseJsonUnknown(readFileSync(stdinFile, 'utf-8')))
    assert.equal(stdin['loop_count'], 0)
  })

  it('fires on abort with status "aborted"', async () => {
    const stdinFile = join(tempHome, 'aborted.json')
    const script = await writeCaptureHook('stop-aborted.sh', stdinFile)
    await writeUserHooks({ hooks: { stop: [{ command: script }] } })

    const result = await fireStop('aborted')
    assert.equal(result.ran, 1)
    await result.settled
    const stdin = expectRecord(parseJsonUnknown(readFileSync(stdinFile, 'utf-8')))
    assert.equal(stdin['status'], 'aborted')
  })

  it(
    'is detached — completion waits for the caller to release the hook (decision 3)',
    { timeout: 15_000 },
    async () => {
      const marker = join(tempHome, 'completed.marker')
      const release = join(tempHome, 'release.marker')
      const script = join(tempHome, 'gated-hook.sh')
      // Completion is controlled by the caller, not a race between a short
      // sleep and process scheduling under load. This timeout is only a bound
      // for a broken implementation that incorrectly waits for the hook.
      setCursorHookTimeoutForTest(10_000)
      await writeFile(
        script,
        `#!/bin/sh\ncat > /dev/null\nwhile [ ! -f '${release}' ]; do sleep 0.02; done\n: > '${marker}'\n`,
        'utf-8',
      )
      await chmod(script, 0o755)
      await writeUserHooks({ hooks: { stop: [{ command: script }] } })

      const result = await fireStop('completed')
      let completed = false
      const settled = result.settled.then(() => {
        completed = true
      })
      try {
        // Flush a settled promise's reaction: an implementation that awaited
        // the child (including its timeout) must fail this ordering assertion.
        await Promise.resolve()
        assert.equal(result.ran, 1)
        assert.equal(completed, false, 'dispatch must return before the hook settles')
        assert.equal(existsSync(marker), false)
      } finally {
        // Release even after an assertion failure so no live child outlasts
        // its fixture or observes the next test's temporary home.
        await writeFile(release, '')
        await settled
      }
      assert.equal(existsSync(marker), true, 'the released hook must actually complete')
    },
  )

  it('is notification-only — a crashing hook never throws or blocks', async () => {
    const path = join(tempHome, 'crash.sh')
    await writeFile(path, '#!/bin/sh\ncat > /dev/null\nexit 2\n', 'utf-8')
    await chmod(path, 0o755)
    await writeUserHooks({ hooks: { stop: [{ command: path }] } })

    const result = await fireStop('completed')
    assert.equal(result.ran, 1)
    await result.settled
  })

  it('is notification-only — even failClosed cannot block a stop (edit/turn already done)', async () => {
    const path = join(tempHome, 'crash-closed.sh')
    await writeFile(path, '#!/bin/sh\ncat > /dev/null\nexit 2\n', 'utf-8')
    await chmod(path, 0o755)
    await writeUserHooks({ hooks: { stop: [{ command: path, failClosed: true }] } })

    // The runner resolves failClosed to a deny outcome, but stop is detached and
    // notification-only, so runStopHooks ignores it: it neither throws nor
    // surfaces a decision — it just reports the hook ran.
    const result = await fireStop('completed')
    assert.equal(result.ran, 1)
    await result.settled
  })

  it('a project stop hook is ignored unless the workspace is trusted', async () => {
    const stdinFile = join(tempHome, 'proj.json')
    const script = await writeCaptureHook('proj-stop.sh', stdinFile)
    const projectRoot = await mkdtemp(join(tmpdir(), 'copse-stop-proj-'))
    try {
      await mkdir(join(projectRoot, '.cursor'), { recursive: true })
      await writeFile(
        join(projectRoot, '.cursor', 'hooks.json'),
        JSON.stringify({ hooks: { stop: [{ command: script }] } }),
        'utf-8',
      )

      const untrusted = await runStopHooks('completed', {
        threadId: 'stop-trust-untrusted',
        turnTreeId: asTurnTreeId('stop-trust-untrusted:turn'),
        workspaceRoot: projectRoot,
        projectTrusted: false,
      })
      assert.equal(untrusted.ran, 0)
      await untrusted.settled

      const trusted = await runStopHooks('completed', {
        threadId: 'stop-trust-trusted',
        turnTreeId: asTurnTreeId('stop-trust-trusted:turn'),
        workspaceRoot: projectRoot,
        projectTrusted: true,
      })
      assert.equal(trusted.ran, 1)
      await trusted.settled
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
