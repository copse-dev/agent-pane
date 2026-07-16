// Contract test for the A1 host command-runner seam (decision 1 / decision 9).
// A1 only establishes the seam — the real spawn + per-dialect marshalling are
// A2 — so the runner is a not-yet-wired stub that throws rather than silently
// allowing an ungated action. This test pins that, and pins that the throw is
// still contained by the registry's defer-to-dialect safety net (a command hook
// never fail-hards the harness, decision 9).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HookRegistry } from '@copse/agent/hooks/hook-registry.ts'
import type { CommandHook } from '@copse/agent/hooks/command-executor.ts'
import { createCommandHookRunner, CommandHookRunnerNotWiredError } from './command-hook-runner.ts'

function commandHook(onFailure: CommandHook['onFailure']): CommandHook<'toolGate'> {
  return {
    id: './audit.sh',
    event: 'toolGate',
    executor: 'command',
    dialect: 'cursor',
    command: './audit.sh',
    onFailure,
  }
}

describe('host command-hook runner (A1 seam)', () => {
  it('is a not-yet-wired stub that rejects with a descriptive error', async () => {
    const runner = createCommandHookRunner()
    await assert.rejects(
      () => runner.run(commandHook('open'), { toolName: 'run_shell', input: {} }, {}),
      (err: unknown) => {
        assert.ok(err instanceof CommandHookRunnerNotWiredError)
        assert.equal(err.hookId, './audit.sh')
        assert.equal(err.event, 'toolGate')
        return true
      },
    )
  })

  it('is contained by the registry defer-to-dialect net (fail-closed → deny, no throw)', async () => {
    const registry = new HookRegistry()
    registry.registerCommand(commandHook('closed'))
    const result = await registry.emit(
      'toolGate',
      { toolName: 'run_shell', input: {} },
      { runCommandHook: createCommandHookRunner() },
    )
    assert.equal(result.outcomes[0]?.outcome.decision, 'deny')
  })

  it('fail-open stub crash proceeds with no opinion (no throw)', async () => {
    const registry = new HookRegistry()
    registry.registerCommand(commandHook('open'))
    const result = await registry.emit(
      'toolGate',
      { toolName: 'run_shell', input: {} },
      { runCommandHook: createCommandHookRunner() },
    )
    assert.deepEqual(result.outcomes, [])
  })
})
