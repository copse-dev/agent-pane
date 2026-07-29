// Contract tests for the `sessionStart` fire site (H4).
//
// Pins the H4 acceptance surface for session start:
//   - `sessionStart` fires fire-and-forget on a thread's first turn, dispatched
//     detached (a slow hook never blocks — decision 3), with the session id on
//     the marshalled stdin.
//   - A `sessionStart` hook's `env` output is collected into the per-session env
//     store and **reaches the environment of a later hook process spawned in the
//     same session** (the "`sessionEnv` propagation" acceptance point).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expectRecord, parseJsonUnknown } from '@shared/unknown-value.ts'
import { runSessionStartHooks } from './session-start.ts'
import { runToolGateHooks } from './tool-gate.ts'
import { getSessionEnv, resetSessionEnvForTest } from './session-env.ts'
import {
  userHooksConfigPath,
  resetCursorHookSessionErrorsForTest,
  setCursorHookTimeoutForTest,
} from './cursor-adapter.ts'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'

let threadCounter = 0

describe('sessionStart fire site (H4)', () => {
  let tempHome = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-session-start-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    resetCursorHookSessionErrorsForTest()
    resetSessionEnvForTest()
    setCursorHookTimeoutForTest(2_000)
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    resetSessionEnvForTest()
    setCursorHookTimeoutForTest()
    await rm(tempHome, { recursive: true, force: true })
  })

  async function writeUserHooks(config: unknown): Promise<void> {
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(userHooksConfigPath(), JSON.stringify(config), 'utf-8')
  }

  function fire(threadId: string): ReturnType<typeof runSessionStartHooks> {
    return runSessionStartHooks(
      { firstTurn: true },
      {
        threadId,
        turnTreeId: asTurnTreeId(`${threadId}:turn`),
        workspaceRoot: null,
        projectTrusted: false,
        agentSession: { conversationId: threadId, generationId: `${threadId}:g` },
      },
    )
  }

  it('does nothing when no sessionStart hooks are registered', async () => {
    const result = await fire(`ss-none-${String(threadCounter++)}`)
    assert.equal(result.ran, 0)
    await result.settled
  })

  it('fires with the session id on stdin (marshalled Cursor sessionStart shape)', async () => {
    const threadId = `ss-fire-${String(threadCounter++)}`
    const stdinFile = join(tempHome, 'session-start-stdin.json')
    const script = join(tempHome, 'ss.sh')
    await writeFile(script, `#!/bin/sh\ncat > '${stdinFile}'\n`, 'utf-8')
    await chmod(script, 0o755)
    await writeUserHooks({ hooks: { sessionStart: [{ command: script }] } })

    const result = await fire(threadId)
    assert.equal(result.ran, 1)
    await result.settled

    assert.equal(existsSync(stdinFile), true)
    const stdin = expectRecord(parseJsonUnknown(readFileSync(stdinFile, 'utf-8')))
    assert.equal(stdin['session_id'], threadId)
    assert.equal(stdin['composer_mode'], 'agent')
    assert.equal(stdin['is_background_agent'], false)
  })

  it('is detached — a slow sessionStart hook does not block the caller (decision 3)', async () => {
    const threadId = `ss-slow-${String(threadCounter++)}`
    const marker = join(tempHome, 'ss-slow.marker')
    const script = join(tempHome, 'ss-slow.sh')
    await writeFile(script, `#!/bin/sh\ncat > /dev/null\nsleep 0.5\n: > '${marker}'\n`, 'utf-8')
    await chmod(script, 0o755)
    await writeUserHooks({ hooks: { sessionStart: [{ command: script }] } })

    const t0 = Date.now()
    const result = await fire(threadId)
    const elapsed = Date.now() - t0
    assert.equal(result.ran, 1)
    assert.ok(elapsed < 300, `dispatch must not block on the hook; took ${String(elapsed)}ms`)
    assert.equal(existsSync(marker), false)
    await result.settled
    assert.equal(existsSync(marker), true)
  })

  it("collects a hook's `env` output into the session env store", async () => {
    const threadId = `ss-env-${String(threadCounter++)}`
    const script = join(tempHome, 'ss-env.sh')
    await writeFile(
      script,
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"env":{"COPSE_TEST_SESSION_VAR":"hello-h4"}}'\n`,
      'utf-8',
    )
    await chmod(script, 0o755)
    await writeUserHooks({ hooks: { sessionStart: [{ command: script }] } })

    const result = await fire(threadId)
    assert.equal(result.ran, 1)
    await result.settled
    assert.deepEqual(getSessionEnv(threadId), { COPSE_TEST_SESSION_VAR: 'hello-h4' })
  })

  it('propagates sessionEnv into the environment of a later hook spawn in the same session', async () => {
    const threadId = `ss-prop-${String(threadCounter++)}`
    // 1) sessionStart hook exports an env var for the session.
    const ssScript = join(tempHome, 'ss-prop.sh')
    await writeFile(
      ssScript,
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"env":{"COPSE_TEST_SESSION_VAR":"propagated"}}'\n`,
      'utf-8',
    )
    await chmod(ssScript, 0o755)
    await writeUserHooks({ hooks: { sessionStart: [{ command: ssScript }] } })

    const started = await fire(threadId)
    assert.equal(started.ran, 1)
    await started.settled

    // 2) A later toolGate hook echoes the propagated var back as its agentMessage
    //    — proving the value reached the *child process env* of the later spawn.
    const gateScript = join(tempHome, 'gate-echo-env.sh')
    await writeFile(
      gateScript,
      `#!/bin/sh\ncat > /dev/null\nprintf '{"permission":"deny","agentMessage":"%s"}' "$COPSE_TEST_SESSION_VAR"\n`,
      'utf-8',
    )
    await chmod(gateScript, 0o755)
    await writeUserHooks({ hooks: { beforeShellExecution: [{ command: gateScript }] } })

    const decision = await runToolGateHooks(
      { toolName: 'run_shell', args: { command: 'ls' } },
      {
        workspaceRoot: null,
        projectTrusted: false,
        agentSession: { conversationId: threadId, generationId: `${threadId}:g` },
      },
    )
    assert.equal(decision.permission, 'deny')
    assert.equal(decision.agentMessage, 'propagated')
  })

  it('does not leak sessionEnv into a hook spawned for a different session', async () => {
    const sessionA = `ss-iso-a-${String(threadCounter++)}`
    const sessionB = `ss-iso-b-${String(threadCounter++)}`
    const ssScript = join(tempHome, 'ss-iso.sh')
    await writeFile(
      ssScript,
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"env":{"COPSE_TEST_SESSION_VAR":"only-A"}}'\n`,
      'utf-8',
    )
    await chmod(ssScript, 0o755)
    await writeUserHooks({ hooks: { sessionStart: [{ command: ssScript }] } })
    const started = await fire(sessionA)
    await started.settled

    const gateScript = join(tempHome, 'gate-iso.sh')
    await writeFile(
      gateScript,
      `#!/bin/sh\ncat > /dev/null\nprintf '{"permission":"deny","agentMessage":"[%s]"}' "$COPSE_TEST_SESSION_VAR"\n`,
      'utf-8',
    )
    await chmod(gateScript, 0o755)
    await writeUserHooks({ hooks: { beforeShellExecution: [{ command: gateScript }] } })

    // Session B never ran sessionStart, so its later hook sees no session var.
    const decision = await runToolGateHooks(
      { toolName: 'run_shell', args: { command: 'ls' } },
      {
        workspaceRoot: null,
        projectTrusted: false,
        agentSession: { conversationId: sessionB, generationId: `${sessionB}:g` },
      },
    )
    assert.equal(decision.permission, 'deny')
    assert.equal(decision.agentMessage, '[]')
  })
})
