// Decision 9 (docs/plans/hooks-and-feature-packs.md) — the A2 acceptance
// criterion: Cursor hooks fail **open by default**, but a per-hook
// `failClosed: true` must make crash / timeout / invalid JSON **block** the
// gated action. Both modes are pinned here for all three failure modes, in the
// house style of `permission-platform.test.ts` (a test file named for the
// decision it pins).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  userHooksConfigPath,
  resetCursorHookSessionErrorsForTest,
  setCursorHookTimeoutForTest,
} from './cursor-adapter.ts'
import { runToolGateHooks } from './tool-gate.ts'

/** A hook script + whether its declaration sets `failClosed: true`. */
type FailureMode = 'crash' | 'timeout' | 'invalid-json'

describe('Cursor failClosed — both modes (decision 9)', () => {
  let tempHome = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-failclosed-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    resetCursorHookSessionErrorsForTest()
    // Keep the timeout failure mode fast — real hooks default to 5s.
    setCursorHookTimeoutForTest(150)
  })

  afterEach(async () => {
    setCursorHookTimeoutForTest()
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    await rm(tempHome, { recursive: true, force: true })
  })

  /** Write a hook script that reproduces `mode`, then declare it (optionally failClosed). */
  async function writeFailingHook(mode: FailureMode, failClosed: boolean): Promise<void> {
    const path = join(tempHome, `${mode}.sh`)
    const body =
      mode === 'crash'
        ? '#!/bin/sh\ncat > /dev/null\nexit 7\n'
        : mode === 'timeout'
          ? '#!/bin/sh\ncat > /dev/null\nsleep 5\n'
          : `#!/bin/sh\ncat > /dev/null\nprintf '%s' 'definitely not json'\n`
    await writeFile(path, body, 'utf-8')
    await chmod(path, 0o755)
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(
      userHooksConfigPath(),
      JSON.stringify({
        hooks: {
          beforeShellExecution: [{ command: path, ...(failClosed ? { failClosed: true } : {}) }],
        },
      }),
      'utf-8',
    )
  }

  function gate(): ReturnType<typeof runToolGateHooks> {
    return runToolGateHooks(
      { toolName: 'run_shell', args: { command: 'rm -rf /' } },
      { workspaceRoot: null, projectTrusted: false },
    )
  }

  const modes: FailureMode[] = ['crash', 'timeout', 'invalid-json']

  describe('default (fail-open): a broken hook never blocks the action', () => {
    for (const mode of modes) {
      it(`${mode} → allow`, async () => {
        await writeFailingHook(mode, false)
        assert.equal((await gate()).permission, 'allow')
      })
    }
  })

  describe('failClosed: true: a broken hook blocks the action', () => {
    for (const mode of modes) {
      it(`${mode} → deny`, async () => {
        await writeFailingHook(mode, true)
        const decision = await gate()
        assert.equal(decision.permission, 'deny')
        // The block is attributed to failClosed so the reason is auditable.
        assert.match(decision.agentMessage ?? '', /failClosed/)
      })
    }
  })
})
