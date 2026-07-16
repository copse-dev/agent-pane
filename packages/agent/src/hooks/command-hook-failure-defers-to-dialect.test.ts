// Contract test for decision 9 of docs/plans/hooks-and-feature-packs.md, named
// for the semantic it pins (execution-guidance rule 2): the two executor kinds
// have two failure policies.
//
//   - First-party FUNCTION hooks **fail hard** — a throw is a bug and surfaces
//     as a HookExecutionError, never downgraded to an allow.
//   - Command (spawned) hooks **defer failure to their dialect** — the runner
//     resolves crash / timeout / invalid JSON per the hook's `onFailure`
//     (Cursor fails open by default but honours `failClosed`; Claude denies on
//     exit 2; Copse uses `onFailure: open|closed`) BEFORE returning, so a
//     command failure is a normalized outcome (or none), never a thrown emit.
//     Even a runner that itself throws is caught and resolved the same way, so
//     one buggy command hook can never fail-hard the harness.
//
// A2's dialect adapters populate the real per-dialect resolution; A1 pins the
// registry contract here with a fake runner standing in for the adapter.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HookRegistry, HookExecutionError } from './hook-registry.ts'
import type { FunctionHookContext } from './canonical-events.ts'
import type { CommandHook, CommandHookResult, CommandHookRunner } from './command-executor.ts'

const gatePayload = { toolName: 'run_shell', input: { command: 'ls' } }

/** A fake dialect runner returning a scripted result (or throwing) per hook id. */
function fakeRunner(results: Record<string, CommandHookResult | (() => never)>): CommandHookRunner {
  return {
    run(hook): Promise<CommandHookResult> {
      const scripted = results[hook.id]
      if (typeof scripted === 'function') return scripted()
      return Promise.resolve(scripted ?? { outcome: null, failed: false })
    },
  }
}

function commandHook(id: string, onFailure: CommandHook['onFailure']): CommandHook<'toolGate'> {
  return {
    id,
    event: 'toolGate',
    executor: 'command',
    dialect: 'cursor',
    command: `./${id}.sh`,
    onFailure,
  }
}

describe('command-hook-failure-defers-to-dialect (decision 9)', () => {
  it('registers command hooks alongside function hooks on the same event', () => {
    const registry = new HookRegistry()
    registry.register({ id: 'fn-gate', event: 'toolGate', run: () => ({ decision: 'allow' }) })
    registry.registerCommand(commandHook('cmd-gate', 'open'))
    assert.deepEqual(
      registry.hooksFor('toolGate').map((h) => h.id),
      ['fn-gate'],
    )
    assert.deepEqual(
      registry.commandHooksFor('toolGate').map((h) => h.id),
      ['cmd-gate'],
    )
  })

  it('a fail-open command failure yields no opinion (action proceeds), never a throw', async () => {
    const registry = new HookRegistry()
    registry.registerCommand(commandHook('opener', 'open'))
    const context: FunctionHookContext = {
      runCommandHook: fakeRunner({ opener: { outcome: null, failed: true, failureMode: 'open' } }),
    }
    const result = await registry.emit('toolGate', gatePayload, context)
    assert.deepEqual(result.outcomes, [])
  })

  it('a fail-closed command failure denies the action, still never a throw', async () => {
    const registry = new HookRegistry()
    registry.registerCommand(commandHook('closer', 'closed'))
    const context: FunctionHookContext = {
      runCommandHook: fakeRunner({
        closer: { outcome: { decision: 'deny' }, failed: true, failureMode: 'closed' },
      }),
    }
    const result = await registry.emit('toolGate', gatePayload, context)
    assert.deepEqual(result.outcomes, [{ hookId: 'closer', outcome: { decision: 'deny' } }])
  })

  it('a runner that throws is resolved by the hook onFailure, not fail-hard', async () => {
    const boom = (): never => {
      throw new Error('runner crashed')
    }
    // Fail-open runner crash → no opinion.
    const openRegistry = new HookRegistry()
    openRegistry.registerCommand(commandHook('open-crash', 'open'))
    const openResult = await openRegistry.emit('toolGate', gatePayload, {
      runCommandHook: fakeRunner({ 'open-crash': boom }),
    })
    assert.deepEqual(openResult.outcomes, [])

    // Fail-closed runner crash → deny, with the crash surfaced to the model.
    const closedRegistry = new HookRegistry()
    closedRegistry.registerCommand(commandHook('closed-crash', 'closed'))
    const closedResult = await closedRegistry.emit('toolGate', gatePayload, {
      runCommandHook: fakeRunner({ 'closed-crash': boom }),
    })
    const [closed] = closedResult.outcomes
    assert.ok(closed)
    assert.equal(closed.outcome.decision, 'deny')
    assert.match(closed.outcome.agentMessage ?? '', /runner crashed/)
  })

  it('function hooks still FAIL HARD on the same event (contrast with command hooks)', async () => {
    const registry = new HookRegistry()
    registry.register({
      id: 'throwing-fn',
      event: 'toolGate',
      run: () => {
        throw new Error('function bug')
      },
    })
    await assert.rejects(() => registry.emit('toolGate', gatePayload, {}), HookExecutionError)
  })

  it('command hooks are skipped (never fail) when no runner is injected', async () => {
    const registry = new HookRegistry()
    registry.register({ id: 'fn-gate', event: 'toolGate', run: () => ({ decision: 'allow' }) })
    registry.registerCommand(commandHook('needs-runner', 'closed'))
    // No runCommandHook on the context: the command hook is skipped, the
    // function hook still runs, and nothing throws.
    const result = await registry.emit('toolGate', gatePayload, {})
    assert.deepEqual(result.outcomes, [{ hookId: 'fn-gate', outcome: { decision: 'allow' } }])
  })

  it('dispatches function hooks before command hooks in one emit', async () => {
    const registry = new HookRegistry()
    registry.register({ id: 'fn-gate', event: 'toolGate', run: () => ({ injectContext: 'fn' }) })
    registry.registerCommand(commandHook('cmd-gate', 'open'))
    const result = await registry.emit('toolGate', gatePayload, {
      runCommandHook: fakeRunner({
        'cmd-gate': { outcome: { injectContext: 'cmd' }, failed: false },
      }),
    })
    assert.deepEqual(
      result.outcomes.map((o) => o.hookId),
      ['fn-gate', 'cmd-gate'],
    )
  })
})
