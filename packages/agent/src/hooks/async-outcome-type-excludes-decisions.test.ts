// Contract test for decision 11 (and 4) of docs/plans/hooks-and-feature-packs.md,
// named for the decision it pins (execution-guidance rule 2). A type-level test
// via `@ts-expect-error` is explicitly acceptable here.
//
// Decisions 4 & 11 require blocking and async hooks to have *separate* outcome
// types so an async hook — which has already left the critical path and can only
// report back through the pending-message queue — cannot influence the current
// action. Splitting the type makes `decision`, `updatedInput`, and
// `injectContext` on an async hook a **compile error** instead of a runtime bug
// (execution-guidance rule 3, "make illegal states unrepresentable"). If any of
// those properties ever becomes assignable to `AsyncHookOutcome`, the matching
// `@ts-expect-error` below turns into an unused-directive typecheck failure.
//
// One object literal per property: excess-property checking only reports the
// first offender in a single literal, so each forbidden field needs its own.
// `void` keeps each value used under `noUnusedLocals`. There is no runtime
// assertion — the compiler *is* the assertion — but a trivial runtime `it` keeps
// the node test runner from reporting an empty suite.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AsyncHookOutcome } from './hook-outcome.ts'

const asyncCannotDecide: AsyncHookOutcome = {
  // @ts-expect-error `decision` is blocking-only (decisions 4 & 11)
  decision: 'allow',
}
const asyncCannotRewriteInput: AsyncHookOutcome = {
  // @ts-expect-error `updatedInput` is blocking-only (decisions 4 & 11)
  updatedInput: {},
}
const asyncCannotInjectContext: AsyncHookOutcome = {
  // @ts-expect-error `injectContext` is blocking-only (decision 11)
  injectContext: 'nope',
}

// An async hook *may* still use its legitimate channels — the queue message,
// halt-run, a user-facing card, and sessionStart env. This positive case guards
// against over-tightening the split into uselessness.
const asyncLegitimate: AsyncHookOutcome = {
  haltRun: { reason: 'programmatic stop' },
  queueMessage: { text: 'follow up', sendNow: false },
  userMessage: 'ran a check',
  sessionEnv: { FOO: 'bar' },
}

void asyncCannotDecide
void asyncCannotRewriteInput
void asyncCannotInjectContext

describe('async-outcome-type-excludes-decisions (decision 11)', () => {
  it('compiles only because async outcomes exclude decision/updatedInput/injectContext', () => {
    // The real assertions are the three `@ts-expect-error`s above; this keeps
    // the legitimate-channel object referenced and the suite non-empty.
    assert.equal(asyncLegitimate.queueMessage?.sendNow, false)
  })
})
