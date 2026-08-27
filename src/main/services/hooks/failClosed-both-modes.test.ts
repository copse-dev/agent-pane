// Decision 9 (docs/plans/hooks-and-feature-packs.md): Copse tightens Cursor hooks
// to fail closed by default. An explicit `failClosed: false` restores fail-open
// for a compatible hook. Coverage spans every wired permission event —
// `beforeShellExecution`, `beforeMCPExecution`, and `beforeReadFile` — both modes
// × all three failure modes. House style of `permission-platform.test.ts` (a test
// file named for the decision it pins).
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
import { runToolGateHooks, type ToolGateCheck } from './tool-gate.ts'

type FailureMode = 'crash' | 'timeout' | 'invalid-json'

/** Each wired Cursor permission event + a tool call that maps onto it. */
const PERMISSION_EVENTS: ReadonlyArray<{ event: string; check: ToolGateCheck }> = [
  {
    event: 'beforeShellExecution',
    check: { toolName: 'run_shell', args: { command: 'rm -rf /' } },
  },
  { event: 'beforeMCPExecution', check: { toolName: 'mcp__srv__tool', args: {} } },
  { event: 'beforeReadFile', check: { toolName: 'read_file', args: { path: '/etc/hosts' } } },
]

describe('Cursor failClosed — both modes, every permission event (decision 9 / B4)', () => {
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

  /** Write a hook script that reproduces `mode`, with failClosed optional. */
  async function writeFailingHook(
    event: string,
    mode: FailureMode,
    failClosed: boolean | undefined,
  ): Promise<void> {
    const path = join(tempHome, `${event}-${mode}.sh`)
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
          [event]: [{ command: path, ...(failClosed !== undefined ? { failClosed } : {}) }],
        },
      }),
      'utf-8',
    )
  }

  const modes: FailureMode[] = ['crash', 'timeout', 'invalid-json']

  for (const { event, check } of PERMISSION_EVENTS) {
    describe(event, () => {
      describe('explicit failClosed:false: a broken hook does not block the action', () => {
        for (const mode of modes) {
          it(`${mode} → allow`, async () => {
            await writeFailingHook(event, mode, false)
            const decision = await runToolGateHooks(check, {
              workspaceRoot: null,
              projectTrusted: false,
            })
            assert.equal(decision.permission, 'allow')
          })
        }
      })

      describe('default: a broken hook blocks the action', () => {
        for (const mode of modes) {
          it(`${mode} → deny`, async () => {
            await writeFailingHook(event, mode, undefined)
            const decision = await runToolGateHooks(check, {
              workspaceRoot: null,
              projectTrusted: false,
            })
            assert.equal(decision.permission, 'deny')
            // The block is attributed to failClosed so the reason is auditable.
            assert.match(decision.agentMessage ?? '', /failClosed/)
          })
        }
      })
    })
  }
})
