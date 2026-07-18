// Contract tests for the subagent-lifecycle fire sites (D1).
//
// Pins the D1 acceptance surface, in the same house style as `stop.test.ts` —
// real spawned scripts driven through the canonical `subagentStart` /
// `subagentStop` registry → runner → adapter seam:
//
//   - subagentStart is a **blocking deny gate**: `permission: deny` (and `ask`,
//     which Cursor treats as deny) blocks the spawn; `allow` proceeds.
//   - the **matcher filters by subagent type**: a hook only fires for a matching
//     type.
//   - subagentStop is **detached** (decision 3) and fires on completion; a
//     `followup_message` (on `status: completed`) routes through the pending-
//     message **queue channel** (C2/C3), never a bespoke protocol.
//   - `failClosed` blocks a crashing subagentStart; fail-open lets it through.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  userHooksConfigPath,
  resetCursorHookSessionErrorsForTest,
  setCursorHookTimeoutForTest,
} from './cursor-adapter.ts'
import { runSubagentStartHooks, runSubagentStopHooks } from './subagent.ts'
import { setHookQueueMessageSender } from './hook-queue-channel.ts'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import type { HookQueueMessagePayload } from '@shared/types/hooks.ts'

let threadCounter = 0

describe('subagent hooks (D1 fire sites)', () => {
  let tempHome = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-subagent-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    resetCursorHookSessionErrorsForTest()
    setCursorHookTimeoutForTest(2_000)
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    setCursorHookTimeoutForTest()
    setHookQueueMessageSender(null)
    await rm(tempHome, { recursive: true, force: true })
  })

  async function writeUserHooks(config: unknown): Promise<void> {
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(userHooksConfigPath(), JSON.stringify(config), 'utf-8')
  }

  /** Write an executable shell script that prints `stdout` and exits 0. */
  async function writeRespondingHook(name: string, stdout: string): Promise<string> {
    const path = join(tempHome, name)
    await writeFile(path, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${stdout}'\n`, 'utf-8')
    await chmod(path, 0o755)
    return path
  }

  /** Write an executable shell script that copies its stdin to `stdinFile`. */
  async function writeCaptureHook(name: string, stdinFile: string): Promise<string> {
    const path = join(tempHome, name)
    await writeFile(path, `#!/bin/sh\ncat > '${stdinFile}'\n`, 'utf-8')
    await chmod(path, 0o755)
    return path
  }

  const discover = { workspaceRoot: null, projectTrusted: false }

  // --- subagentStart: blocking deny gate ---

  it('does not deny when no subagentStart hooks are registered', async () => {
    const decision = await runSubagentStartHooks('explore', discover)
    assert.equal(decision.denied, false)
  })

  it('denies the spawn on permission: deny, carrying user_message', async () => {
    const script = await writeRespondingHook(
      'deny.sh',
      '{"permission":"deny","user_message":"exploration is disabled"}',
    )
    await writeUserHooks({ hooks: { subagentStart: [{ command: script }] } })

    const decision = await runSubagentStartHooks('explore', discover)
    assert.equal(decision.denied, true)
    assert.equal(decision.userMessage, 'exploration is disabled')
  })

  it('treats permission: ask as deny (Cursor contract for subagentStart)', async () => {
    const script = await writeRespondingHook('ask.sh', '{"permission":"ask"}')
    await writeUserHooks({ hooks: { subagentStart: [{ command: script }] } })

    const decision = await runSubagentStartHooks('explore', discover)
    assert.equal(decision.denied, true)
  })

  it('allows the spawn on permission: allow', async () => {
    const script = await writeRespondingHook('allow.sh', '{"permission":"allow"}')
    await writeUserHooks({ hooks: { subagentStart: [{ command: script }] } })

    const decision = await runSubagentStartHooks('explore', discover)
    assert.equal(decision.denied, false)
  })

  // --- matcher on subagent type ---

  it('matcher filters by subagent type: fires only for a matching type', async () => {
    const stdinFile = join(tempHome, 'matched.json')
    const script = await writeCaptureHook('match.sh', stdinFile)
    await writeUserHooks({
      hooks: { subagentStart: [{ command: script, matcher: 'investigate_ci' }] },
    })

    // Non-matching type: the hook is filtered out entirely — nothing fires.
    const explore = await runSubagentStartHooks('explore', discover)
    assert.equal(explore.denied, false)
    assert.equal(existsSync(stdinFile), false)

    // Matching type: the hook fires and receives the subagent type on stdin.
    await runSubagentStartHooks('investigate_ci', discover)
    assert.equal(existsSync(stdinFile), true)
    const stdin = JSON.parse(readFileSync(stdinFile, 'utf-8')) as { subagent_type?: string }
    assert.equal(stdin.subagent_type, 'investigate_ci')
  })

  // --- failClosed on the blocking gate ---

  it('failClosed blocks a crashing subagentStart hook; fail-open lets it through', async () => {
    const crash = join(tempHome, 'crash.sh')
    await writeFile(crash, '#!/bin/sh\ncat > /dev/null\nexit 2\n', 'utf-8')
    await chmod(crash, 0o755)

    await writeUserHooks({ hooks: { subagentStart: [{ command: crash, failClosed: true }] } })
    const closed = await runSubagentStartHooks('explore', discover)
    assert.equal(closed.denied, true)

    await writeUserHooks({ hooks: { subagentStart: [{ command: crash }] } })
    const open = await runSubagentStartHooks('explore', discover)
    assert.equal(open.denied, false)
  })

  // --- subagentStop: detached completion + follow-up routing ---

  function fireStop(
    subagentType: string,
    status: 'completed' | 'error' | 'aborted',
  ): ReturnType<typeof runSubagentStopHooks> {
    const threadId = `subagent-stop-${String(threadCounter++)}`
    return runSubagentStopHooks(
      { subagentType, status },
      { threadId, turnTreeId: asTurnTreeId(`${threadId}:turn`), ...discover },
    )
  }

  it('does nothing when no subagentStop hooks are registered', async () => {
    const result = await fireStop('explore', 'completed')
    assert.equal(result.ran, 0)
    await result.settled
  })

  it('fires subagentStop detached with subagent_type + status on stdin', async () => {
    const stdinFile = join(tempHome, 'stop.json')
    const script = await writeCaptureHook('stop.sh', stdinFile)
    await writeUserHooks({ hooks: { subagentStop: [{ command: script }] } })

    const result = await fireStop('explore', 'completed')
    assert.equal(result.ran, 1)
    await result.settled
    const stdin = JSON.parse(readFileSync(stdinFile, 'utf-8')) as {
      subagent_type?: string
      status?: string
    }
    assert.equal(stdin.subagent_type, 'explore')
    assert.equal(stdin.status, 'completed')
  })

  it('routes a subagentStop followup_message through the queue channel (completed)', async () => {
    const captured: HookQueueMessagePayload[] = []
    setHookQueueMessageSender((p) => captured.push(p))
    const script = await writeRespondingHook(
      'followup.sh',
      '{"followup_message":"continue with the next step"}',
    )
    await writeUserHooks({ hooks: { subagentStop: [{ command: script }] } })

    const result = await fireStop('explore', 'completed')
    assert.equal(result.ran, 1)
    await result.settled

    assert.equal(captured.length, 1)
    const msg = captured[0]
    assert.ok(msg)
    assert.equal(msg.text, 'continue with the next step')
    assert.equal(msg.sendNow, false)
    assert.equal(msg.origin.kind, 'hook')
    assert.equal(msg.origin.event, 'subagentStop')
  })

  it('does not route a followup_message when the subagent did not complete', async () => {
    const captured: HookQueueMessagePayload[] = []
    setHookQueueMessageSender((p) => captured.push(p))
    const script = await writeRespondingHook('followup-err.sh', '{"followup_message":"retry"}')
    await writeUserHooks({ hooks: { subagentStop: [{ command: script }] } })

    const result = await fireStop('explore', 'error')
    assert.equal(result.ran, 1)
    await result.settled
    assert.equal(captured.length, 0)
  })

  it('subagentStop matcher filters by subagent type', async () => {
    const stdinFile = join(tempHome, 'stop-matched.json')
    const script = await writeCaptureHook('stop-match.sh', stdinFile)
    await writeUserHooks({
      hooks: { subagentStop: [{ command: script, matcher: 'explore' }] },
    })

    const nonMatch = await fireStop('investigate_ci', 'completed')
    assert.equal(nonMatch.ran, 0)
    await nonMatch.settled
    assert.equal(existsSync(stdinFile), false)

    const match = await fireStop('explore', 'completed')
    assert.equal(match.ran, 1)
    await match.settled
    assert.equal(existsSync(stdinFile), true)
  })
})
