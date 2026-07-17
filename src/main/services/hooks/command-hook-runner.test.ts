// Contract test for the host command-runner seam (decision 1 / decision 9).
// A2 replaces A1's not-yet-wired stub with the real spawn + per-dialect
// marshalling. This pins the seam contract: the runner spawns via the dialect
// adapter, and a *failed* run (here a command that does not exist → non-zero
// exit) is resolved by the hook's `onFailure` — `closed` → deny, `open` → no
// opinion — so a command hook never fail-hards the harness.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HookRegistry } from '@copse/agent/hooks/hook-registry.ts'
import type { CommandHook } from '@copse/agent/hooks/command-executor.ts'
import { createCommandHookRunner } from './command-hook-runner.ts'

/** A cursor command hook pointing at a command that does not exist (exits non-zero). */
function missingCommandHook(onFailure: CommandHook['onFailure']): CommandHook<'toolGate'> {
  return {
    id: 'copse-nonexistent-hook-xyz',
    event: 'toolGate',
    executor: 'command',
    dialect: 'cursor',
    command: 'copse-nonexistent-hook-xyz',
    onFailure,
    cwd: process.cwd(),
    timeoutMs: 2_000,
  }
}

describe('host command-hook runner (A2 real spawn)', () => {
  it('abstains for an event with no fire site wired yet', async () => {
    const runner = createCommandHookRunner()
    // `afterToolUse` (D2) has no runner branch yet, so the runner abstains
    // without spawning — even a failClosed hook is a clean no-op.
    const unwiredHook: CommandHook<'afterToolUse'> = {
      id: 'copse-nonexistent-hook-xyz',
      event: 'afterToolUse',
      executor: 'command',
      dialect: 'cursor',
      command: 'copse-nonexistent-hook-xyz',
      onFailure: 'closed',
    }
    const result = await runner.run(
      unwiredHook,
      { toolName: 'run_shell', toolCallId: 'call-1', isError: false },
      {},
    )
    assert.deepEqual(result, { outcome: null, failed: false })
  })

  it('failClosed: a crashed command resolves to deny (no throw)', async () => {
    const registry = new HookRegistry()
    registry.registerCommand(missingCommandHook('closed'))
    const result = await registry.emit(
      'toolGate',
      { toolName: 'run_shell', input: { command: 'ls' } },
      { runCommandHook: createCommandHookRunner() },
    )
    assert.equal(result.outcomes[0]?.outcome.decision, 'deny')
  })

  it('fail-open: a crashed command proceeds with no opinion (no throw)', async () => {
    const registry = new HookRegistry()
    registry.registerCommand(missingCommandHook('open'))
    const result = await registry.emit(
      'toolGate',
      { toolName: 'run_shell', input: { command: 'ls' } },
      { runCommandHook: createCommandHookRunner() },
    )
    assert.deepEqual(result.outcomes, [])
  })
})
