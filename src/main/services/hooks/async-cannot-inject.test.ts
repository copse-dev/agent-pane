// H2 / decision 11 (docs/plans/hooks-and-feature-packs.md): only *blocking*
// hooks inject context into the current turn at their fire point. Async
// (detached) hooks cannot — the async outcome *type* excludes `injectContext`
// (pinned type-level in `async-outcome-type-excludes-decisions.test.ts`), and
// their only mid-turn channel is the pending-message queue (`queueMessage`).
//
// This is the runtime companion: the async command-hook interpretations
// (`afterToolUse`, `subagentStop`) must never surface `injectContext`, even when
// a hook prints an `additionalContext` field on its stdout — the field a
// blocking gate would honour. An async hook that wants to reach the model
// mid-turn (Claude's `asyncRewake`) is exactly the path decision 11 refuses:
// its output is converted to a queued message, never injected.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cursorAdapter } from './cursor-adapter.ts'
import type { HookSpawnResult } from './hook-spawn.ts'

/** A clean (exit-0) spawn result whose stdout is `stdout`. */
function cleanSpawn(stdout: string): HookSpawnResult {
  return {
    stdout,
    stderr: '',
    exitCode: 0,
    timedOut: false,
    spawnError: false,
    startedAt: Date.now(),
    durationMs: 1,
  }
}

describe('async hooks cannot inject current-turn context (decision 11)', () => {
  it('interpretAfterToolUse ignores additionalContext (observation-only)', () => {
    const interpretAfterToolUse = cursorAdapter.interpretAfterToolUse?.bind(cursorAdapter)
    assert.ok(interpretAfterToolUse, 'cursor adapter must implement interpretAfterToolUse')
    const spawn = cleanSpawn('{"additionalContext":"try to inject mid-turn"}')
    const interpretation = interpretAfterToolUse(spawn, {
      toolName: 'run_shell',
      toolCallId: 'call-1',
      isError: false,
    })
    // No control-flow outcome at all, so certainly no injectContext.
    assert.equal(interpretation.outcome, null)
    assert.equal(interpretation.spineDecision.injectContextChars, undefined)
  })

  it('interpretSubagentStop converts output to a queued message, never injectContext', () => {
    const interpretSubagentStop = cursorAdapter.interpretSubagentStop?.bind(cursorAdapter)
    assert.ok(interpretSubagentStop, 'cursor adapter must implement interpretSubagentStop')
    const spawn = cleanSpawn(
      '{"additionalContext":"inject me","followup_message":"look at the failing test"}',
    )
    const interpretation = interpretSubagentStop(spawn, {
      subagentType: 'explore',
      status: 'completed',
    })
    // The follow-up rides the async queue channel (decision 4) — not injectContext.
    assert.equal(interpretation.outcome, null)
    assert.deepEqual(interpretation.queueMessage, {
      text: 'look at the failing test',
      sendNow: false,
    })
    assert.equal(interpretation.spineDecision.injectContextChars, undefined)
  })
})
