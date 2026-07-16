// Contract test for decision 15 of docs/plans/hooks-and-feature-packs.md, named
// for the capability split it pins (execution-guidance rule 2). A type-level
// test via `@ts-expect-error` is the right tool: the split is a *compile-time*
// boundary, not a runtime check.
//
// Decision 15: first-party FUNCTION hooks additionally get typed
// `AgentStreamChunk` emission and typed loop-state access; "External hooks can
// never emit feature chunks (`todo_update`, `subagent_*`) — the typed stream
// stays first-party, which keeps transcripts trustworthy." We encode that as
// two context types: function hooks receive `FunctionHookContext` (with
// `emitChunk` + `loopState`); the command runner is handed only the base
// `HookContext`, so a command hook reaching for either capability is a compile
// error, not a review comment (execution-guidance rule 3).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentStreamChunk } from '../wire-types.ts'
import type { FunctionHookContext } from './canonical-events.ts'
import type { CommandHookRunner } from './command-executor.ts'

// Positive case: a function hook's context CAN emit typed chunks and read loop
// state. If either capability disappeared from `FunctionHookContext`, this stops
// compiling — guarding against accidentally stripping the first-party privilege.
function functionHookUsesFirstPartyCapabilities(ctx: FunctionHookContext): number | undefined {
  const chunk: AgentStreamChunk = { type: 'text_replace', text: 'first-party only' }
  ctx.emitChunk?.(chunk)
  return ctx.loopState?.step
}

// Negative case: the command runner receives only the base context. Emitting a
// typed chunk or reading loop state from it must NOT type-check.
const capabilityFreeRunner: CommandHookRunner = {
  run(_hook, _payload, context) {
    // @ts-expect-error command hooks cannot emit typed feature chunks (decision 15)
    void context.emitChunk
    // @ts-expect-error command hooks cannot read live loop state (decision 15)
    void context.loopState
    return Promise.resolve({ outcome: null, failed: false })
  },
}

describe('command-hooks-cannot-emit-feature-chunks (decision 15)', () => {
  it('function hooks keep typed chunk + loop-state capabilities; command hooks do not', () => {
    // The compiler is the real assertion (the `@ts-expect-error`s above). These
    // keep both values referenced and the suite non-empty.
    assert.equal(functionHookUsesFirstPartyCapabilities({}), undefined)
    assert.equal(typeof capabilityFreeRunner.run, 'function')
  })
})
